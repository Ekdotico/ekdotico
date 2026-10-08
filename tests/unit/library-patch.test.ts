// NFR-SE-19; decision 0004: the identity library is installed with one line
// patched out. A fault of the database, handed whole to `console.error`, would
// put the message of the database and its query in a log. This fails where the
// patch is not applied: after an update of the library, or an install that
// passed over `pnpm.patchedDependencies`.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// The copy the library itself loads: its sibling in the package store.
const core = join(realpathSync('node_modules/better-auth'), '..', '@better-auth', 'core');
const { version } = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8'));

describe('the patch of the identity library', () => {
  it('is recorded for the version that is installed', () => {
    expect(version).toBe(pkg.dependencies['better-auth']);
    const patch = pkg.pnpm.patchedDependencies[`@better-auth/core@${version}`];
    expect(readFileSync(patch, 'utf8')).toContain('-\t\t\tconsole.error(error);');
  });

  it('is applied: the join of a second query prints no error itself', () => {
    const factory = readFileSync(join(core, 'dist/db/adapter/factory.mjs'), 'utf8');
    const from = factory.indexOf('const handleFallbackJoin');
    const join_ = factory.slice(from, factory.indexOf('const adapterInstance', from));
    // The function is there, so that a file that moved does not pass for a patched one.
    expect(join_).toContain('Failed to query fallback join');
    expect(join_).not.toMatch(/console\s*\./);
  });
});
