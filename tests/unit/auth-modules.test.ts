// The modules of src/lib/auth load whichever of them is asked for first. A
// page imports password.ts or session-list.ts without auth.ts, and auth.ts
// mounts the endpoints of both: were one of them to import its way back to
// auth.ts at load, the build of that page would fail (and it did, once).
//
// Under plain Node.js, in a process of its own for each: the test runner loads
// modules in its own way, which forgives the circle.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe.each(['password.ts', 'session-list.ts', 'session.ts', 'sign-in.ts', 'auth.ts', '../timers.ts'])(
  'src/lib/auth/%s',
  (first) => {
    it('loads first, and auth.ts after it', () => {
      const ran = spawnSync(
        'node',
        [
          '--input-type=module',
          '--eval',
          `await import('./src/lib/auth/${first}'); const { IDENTITY_ENDPOINTS } = await import('./src/lib/auth/auth.ts'); if (IDENTITY_ENDPOINTS.size < 1) process.exit(2);`,
        ],
        { encoding: 'utf8' },
      );
      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
    });
  },
);
