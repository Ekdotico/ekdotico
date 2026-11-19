// SeaweedFS gives every bucket 7 volumes of its own, and without -volume.max it caps the volumes by the
// free disk. On a CI runner that is a handful: the fourth bucket's first write then fails with
// "InternalError 500" (the six failures of tests/integration/backup.test.ts, run 44142861099). The
// definitions of the local store, in CI and in compose.yaml, must set the cap themselves.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MINIMUM = 100;

describe.each(['.github/workflows/ci.yml', 'compose.yaml'])('the object store in %s', (file) => {
  it('sets -volume.max to at least 100', () => {
    const line = readFileSync(file, 'utf8')
      .split('\n')
      .find((each) => each.includes('server -s3'));
    expect(line, 'the line that starts the store').toBeDefined();
    const given = /-volume\.max=(\d+)/.exec(line!)?.[1];
    expect(Number(given ?? 0)).toBeGreaterThanOrEqual(MINIMUM);
  });
});
