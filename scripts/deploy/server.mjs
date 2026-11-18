// Runs ON THE SERVER, as the deployer's ssh user, from the copy that deploy.mjs sends next to the release
// (docs/operations/deployment.md, "Deploying a release"). Plain Node, no dependency.
//
//   node server.mjs stage    --base <dir> --sha <sha> --tarball <file> --sha256 <hex>
//   node server.mjs migrate  --base <dir> --sha <sha> --env-file <file>
//   node server.mjs switch   --base <dir> --sha <sha> [--web-port 3000] [--collab-port 1234]
//   node server.mjs rollback --base <dir> [--web-port 3000] [--collab-port 1234]
//   node server.mjs prune    --base <dir> [--keep 3]
//   node server.mjs status   --base <dir>
//
// Layout under <base>: releases/<sha>/ (one per release), `current` (a symbolic link to the running one, relative
// to <base>), and `.previous` (the target `current` had before the last switch, which `rollback` returns to).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManifest, checkSha, parseArgs, releasesToPrune, switchTo, verifyChecksum } from './lib.mjs';

export const UNITS = ['ekdotico-collab.service', 'ekdotico-web.service'];

/** The file-system half of the switch, on <base>. Exported for the tests, which run it on a temporary directory. */
export function fsOps(base) {
  const current = join(base, 'current');
  return {
    readCurrent: () => readlinkSync(current),
    readPrevious: () => readFileSync(join(base, '.previous'), 'utf8').trim(),
    writePrevious: (target) => writeFileSync(join(base, '.previous'), `${target}\n`),
    // A new link beside the old one, renamed over it: rename(2) replaces `current` in one step, so there is no
    // moment at which it is missing.
    link(target) {
      if (!existsSync(join(base, target))) throw new Error(`${join(base, target)} does not exist`);
      const next = join(base, 'current.next');
      rmSync(next, { force: true });
      symlinkSync(target, next);
      renameSync(next, current);
    },
  };
}

const privileged = (command) => (process.getuid?.() === 0 ? command : ['sudo', '-n', ...command]);
const run = (command, options = {}) =>
  execFileSync(command[0], command.slice(1), { stdio: 'inherit', ...options });

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5000) })).status === 200;
  } catch {
    return false;
  }
}

/** Both units active and both health routes answering 200, polled for up to `seconds`. */
export function serviceOps({
  webPort = 3000,
  collabPort = 1234,
  seconds = 90,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  return {
    restart: async () => run(privileged(['systemctl', 'restart', ...UNITS])),
    async healthy() {
      for (let waited = 0; waited <= seconds; waited += 3) {
        const active = UNITS.every((unit) => {
          try {
            execFileSync('systemctl', ['is-active', '--quiet', unit]);
            return true;
          } catch {
            return false;
          }
        });
        if (
          active &&
          (await answers(`http://127.0.0.1:${webPort}/api/health`)) &&
          (await answers(`http://127.0.0.1:${collabPort}/collab/health`))
        ) {
          return true;
        }
        await sleep(3000);
      }
      return false;
    },
  };
}

export async function stage({ base, sha, tarball, sha256 }) {
  checkSha(sha);
  const dir = join(base, 'releases', sha);
  if (existsSync(dir)) throw new Error(`${dir} exists already: a release is staged once`);
  await verifyChecksum(tarball, sha256);
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  try {
    run(['tar', '-xzf', tarball, '-C', partial, '--no-same-owner']);
    checkManifest(JSON.parse(readFileSync(join(partial, 'RELEASE.json'), 'utf8')), { sha });
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
  // The release is read-only to the unit user (group ekdotico, no group write), except Next.js's own cache, which
  // the running application writes (optimised images, the incremental cache) and which the tarball leaves out.
  // Each release has its own, deleted with it: entries of one build are not served by another, and a rollback
  // finds its release's cache as it left it.
  const cache = join(partial, '.next', 'cache');
  mkdirSync(cache, { recursive: true });
  chmodSync(cache, 0o2770);
  renameSync(partial, dir);
  // Pruning ranks releases by this time, the stage time; the archive carries the time of the build.
  const now = new Date();
  utimesSync(dir, now, now);
  console.log(`staged ${dir}`);
}

export function prune({ base, keep = 3 }) {
  const ops = fsOps(base);
  const dir = join(base, 'releases');
  const name = (target) => target?.startsWith('releases/') && target.slice('releases/'.length);
  let previous;
  try {
    previous = name(ops.readPrevious());
  } catch {}
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[0-9a-f]{40}$/.test(e.name))
    .map((e) => ({ name: e.name, mtimeMs: statSync(join(dir, e.name)).mtimeMs }));
  for (const old of releasesToPrune(entries, { keep, current: name(ops.readCurrent()), previous })) {
    rmSync(join(dir, old), { recursive: true, force: true });
    console.log(`pruned ${old}`);
  }
}

async function main([command, ...argv]) {
  const ports = ['web-port', 'collab-port'];
  const args = {
    stage: () => parseArgs(argv, { required: ['base', 'sha', 'tarball', 'sha256'] }),
    migrate: () => parseArgs(argv, { required: ['base', 'sha', 'env-file'] }),
    switch: () => parseArgs(argv, { required: ['base', 'sha'], optional: ports }),
    rollback: () => parseArgs(argv, { required: ['base'], optional: ports }),
    prune: () => parseArgs(argv, { required: ['base'], optional: ['keep'] }),
    status: () => parseArgs(argv, { required: ['base'] }),
  }[command]?.();
  if (!args) throw new Error('usage: server.mjs stage|migrate|switch|rollback|prune|status --base <dir> …');
  const { base } = args;
  const services = () =>
    serviceOps({
      webPort: Number(args['web-port'] ?? 3000),
      collabPort: Number(args['collab-port'] ?? 1234),
    });
  if (command === 'stage') return stage(args);
  if (command === 'migrate') {
    // Run before the switch, from the new release, against the running database: the standing practice is
    // additive migrations only, so the release still running keeps working on the migrated schema.
    const dir = join(base, 'releases', checkSha(args.sha));
    return run(
      ['node', `--env-file=${args['env-file']}`, 'node_modules/prisma/build/index.js', 'migrate', 'deploy'],
      { cwd: dir },
    );
  }
  if (command === 'switch' || command === 'rollback') {
    const ops = fsOps(base);
    const target = command === 'switch' ? `releases/${checkSha(args.sha)}` : ops.readPrevious();
    const { previous, current } = await switchTo(target, { ...ops, ...services() });
    return console.log(`current is ${current} and answers; ${previous} is kept for a rollback`);
  }
  if (command === 'prune') return prune({ base, keep: Number(args.keep ?? 3) });
  const ops = fsOps(base);
  let previous = '(none)';
  try {
    previous = ops.readPrevious();
  } catch {}
  console.log(
    `current: ${ops.readCurrent()}\nprevious: ${previous}\nreleases: ${readdirSync(join(base, 'releases')).join(' ')}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`server.mjs: ${error.message}`);
    process.exit(1);
  });
}
