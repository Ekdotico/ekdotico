import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/check-deps.mjs');
const made: string[] = [];

/** Runs the check in a directory holding one direct dependency, `x`. */
function check(version: string, manifestOfX: object, map = 'dependencies') {
  const dir = mkdtempSync(join(tmpdir(), 'check-deps-'));
  made.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ [map]: { x: version } }));
  mkdirSync(join(dir, 'node_modules/x'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/x/package.json'), JSON.stringify(manifestOfX));
  return spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-deps (NFR-IC-08, NFR-IC-12)', () => {
  it('admits an exact version under a free licence', () => {
    expect(check('1.0.0', { license: 'MIT' }).status).toBe(0);
  });

  it.each(['^1.0.0', '~1.0.0', '1.x', '*', 'latest', '>=1.0.0', 'npm:y@1.0.0'])(
    'refuses the version %s',
    (version) => {
      const result = check(version, { license: 'MIT' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not an exact version');
    },
  );

  it('refuses a range among the optional dependencies', () => {
    expect(check('^1.0.0', { license: 'MIT' }, 'optionalDependencies').status).toBe(1);
  });

  it.each([
    ['no licence field', {}],
    ['a licences array', { licenses: [{ type: 'GPL-3.0' }] }],
    ['a licence that needs review', { license: 'GPL-3.0-only' }],
    ['an expression that offers one', { license: '(MIT OR GPL-3.0-only)' }],
  ])('refuses a package with %s', (_, manifest) => {
    const result = check('1.0.0', manifest);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('x: licence');
  });
});
