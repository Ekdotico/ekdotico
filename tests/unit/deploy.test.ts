// The deployment's logic that runs without a server (scripts/deploy/; docs/operations/deployment.md, "Deploying a
// release"): argument checks, the checksum and manifest checks, sealing, release pruning, and the order of the switch
// and its rollback. Restarting systemd units and the health routes are not exercised here.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readlinkSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkManifest,
  checkSha,
  keyPair,
  parseArgs,
  releasesToPrune,
  seal,
  sha256File,
  switchTo,
  unseal,
  verifyChecksum,
} from '../../scripts/deploy/lib.mjs';
import { fsOps, prune, stage } from '../../scripts/deploy/server.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const here = { platform: 'linux', arch: 'x64', node: 'v26.11.0' };
const manifest = { sha: SHA, deployable: true, ...here, node: 'v26.1.0' };
const temp = () => mkdtempSync(join(tmpdir(), 'deploy-test-'));

describe('argument checks', () => {
  it('takes only a full lower-case sha', () => {
    expect(checkSha(SHA)).toBe(SHA);
    for (const bad of ['a'.repeat(7), 'A'.repeat(40), `${SHA}\n`, '../' + 'a'.repeat(37), undefined]) {
      expect(() => checkSha(bad)).toThrow(/full commit sha/);
    }
  });

  it('refuses unknown, valueless and missing arguments', () => {
    const spec = { required: ['sha'], flags: ['migrate'], optional: ['keep'] };
    expect(parseArgs(['--sha', SHA, '--migrate'], spec)).toEqual({ sha: SHA, migrate: true });
    expect(() => parseArgs(['--host', 'x', '--sha', SHA], spec)).toThrow(/unknown argument/);
    expect(() => parseArgs(['--sha'], spec)).toThrow(/needs a value/);
    expect(() => parseArgs(['--sha', '--migrate'], spec)).toThrow(/needs a value/);
    expect(() => parseArgs(['--migrate'], spec)).toThrow(/--sha is required/);
    expect(() => parseArgs(['stray'], spec)).toThrow(/unknown argument/);
  });
});

describe('the checks of the artifact', () => {
  it('accepts the sha-256 of the file and refuses any other', async () => {
    const file = join(temp(), 'f');
    writeFileSync(file, 'release');
    const sum = await sha256File(file);
    await expect(verifyChecksum(file, sum)).resolves.toBeUndefined();
    await expect(verifyChecksum(file, sum.replace(/^./, sum[0] === '0' ? '1' : '0'))).rejects.toThrow(
      /checksum mismatch/,
    );
    await expect(verifyChecksum(file, undefined)).rejects.toThrow(/no sha-256/);
  });

  it('refuses a manifest of another commit, one not deployable, and another platform, CPU or Node.js major', () => {
    expect(checkManifest(manifest, { sha: SHA, ...here })).toBe(manifest);
    expect(() => checkManifest(manifest, { sha: OTHER, ...here })).toThrow(/not b/);
    expect(() =>
      checkManifest({ ...manifest, deployable: false, reason: 'a pull request' }, { sha: SHA, ...here }),
    ).toThrow(/a pull request/);
    expect(() => checkManifest(manifest, { sha: SHA, ...here, arch: 'arm64' })).toThrow(/linux\/x64/);
    expect(() => checkManifest(manifest, { sha: SHA, ...here, node: 'v27.0.0' })).toThrow(/Node.js/);
  });

  it('opens what was sealed to its key, and nothing that was changed or sealed to another', () => {
    const { publicKey, privateKey } = keyPair();
    const sealed = seal(Buffer.from('the build'), publicKey);
    expect(unseal(sealed, privateKey).toString()).toBe('the build');
    const changed = Buffer.from(sealed);
    changed.writeUInt8((changed.at(-1) ?? 0) ^ 1, changed.length - 1);
    expect(() => unseal(changed, privateKey)).toThrow();
    expect(() => unseal(sealed, keyPair().privateKey)).toThrow();
  });
});

describe('pruning', () => {
  const entries = ['r1', 'r2', 'r3', 'r4', 'r5'].map((name, i) => ({ name, mtimeMs: i }));

  it('keeps the newest and never the current or the previous release', () => {
    expect(releasesToPrune(entries, { keep: 3 })).toEqual(['r2', 'r1']);
    expect(releasesToPrune(entries, { keep: 3, current: 'r1', previous: 'r2' })).toEqual([]);
    expect(releasesToPrune(entries, { keep: 2, current: 'r5', previous: 'r1' })).toEqual(['r3', 'r2']);
  });

  it('refuses to keep fewer than two', () => {
    expect(() => releasesToPrune(entries, { keep: 1 })).toThrow(/at least 2/);
  });

  it('deletes old release directories and leaves the layout’s first one alone', () => {
    const base = temp();
    mkdirSync(join(base, 'app'));
    const shas = ['1', '2', '3', '4'].map((c) => c.repeat(40));
    shas.forEach((sha, i) => {
      mkdirSync(join(base, 'releases', sha), { recursive: true });
      utimesSync(join(base, 'releases', sha), i + 1, i + 1);
    });
    const ops = fsOps(base);
    ops.link(`releases/${shas[3]}`);
    ops.writePrevious('app');
    prune({ base, keep: 2 });
    expect(readdirSync(join(base, 'releases')).sort()).toEqual([shas[2], shas[3]]);
    expect(readdirSync(base)).toContain('app');
  });
});

describe('the switch', () => {
  const fake = (results: boolean[]) => {
    const calls: string[] = [];
    let current = 'releases/old';
    return {
      calls,
      ops: {
        readCurrent: () => current,
        link: (t: string) => (calls.push(`link ${t}`), (current = t)),
        writePrevious: (t: string) => calls.push(`previous ${t}`),
        restart: async () => void calls.push('restart'),
        healthy: async () => (calls.push('check'), results.shift() ?? false),
      },
    };
  };

  it('links, records the previous, restarts and checks, in that order', async () => {
    const { calls, ops } = fake([true]);
    await expect(switchTo('releases/new', ops)).resolves.toEqual({
      previous: 'releases/old',
      current: 'releases/new',
    });
    expect(calls).toEqual(['link releases/new', 'previous releases/old', 'restart', 'check']);
  });

  it('switches back by itself and says so when the check fails', async () => {
    const { calls, ops } = fake([false, true]);
    await expect(switchTo('releases/new', ops)).rejects.toThrow(
      /switched back to releases\/old, which is up again/,
    );
    expect(calls).toEqual([
      'link releases/new',
      'previous releases/old',
      'restart',
      'check',
      'link releases/old',
      'restart',
      'check',
    ]);
  });

  it('says loudly when the rollback fails its check too', async () => {
    const { ops } = fake([false, false]);
    await expect(switchTo('releases/new', ops)).rejects.toThrow(/ALSO FAILS/);
  });

  it('refuses to switch to what is current', async () => {
    const { calls, ops } = fake([true]);
    await expect(switchTo('releases/old', ops)).rejects.toThrow(/already current/);
    expect(calls).toEqual([]);
  });

  it('replaces the link in one rename and refuses a target that does not exist', () => {
    const base = temp();
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'releases', SHA), { recursive: true });
    const ops = fsOps(base);
    ops.link('app');
    ops.link(`releases/${SHA}`);
    expect(readlinkSync(join(base, 'current'))).toBe(`releases/${SHA}`);
    expect(readdirSync(base)).not.toContain('current.next');
    expect(() => ops.link(`releases/${OTHER}`)).toThrow(/does not exist/);
    expect(readlinkSync(join(base, 'current'))).toBe(`releases/${SHA}`);
  });
});

describe('staging', () => {
  const tarball = (m: object) => {
    const src = temp();
    writeFileSync(join(src, 'RELEASE.json'), JSON.stringify(m));
    const file = join(temp(), 'release.tgz');
    execFileSync('tar', ['-czf', file, '-C', src, 'RELEASE.json']);
    return file;
  };
  const node = process.version;
  const real = { sha: SHA, deployable: true, platform: process.platform, arch: process.arch, node };

  it('unpacks a checked release into its own directory, once', async () => {
    const base = temp();
    const file = tarball(real);
    await stage({ base, sha: SHA, tarball: file, sha256: await sha256File(file) });
    expect(readdirSync(join(base, 'releases'))).toEqual([SHA]);
    await expect(stage({ base, sha: SHA, tarball: file, sha256: await sha256File(file) })).rejects.toThrow(
      /exists already/,
    );
  });

  it('unpacks nothing whose checksum is wrong, and keeps nothing whose manifest is of another commit', async () => {
    const base = temp();
    const file = tarball({ ...real, sha: OTHER });
    await expect(stage({ base, sha: SHA, tarball: file, sha256: '0'.repeat(64) })).rejects.toThrow(
      /checksum mismatch/,
    );
    await expect(stage({ base, sha: SHA, tarball: file, sha256: await sha256File(file) })).rejects.toThrow(
      /not a/,
    );
    expect(readdirSync(join(base, 'releases'))).toEqual([]);
  });
});
