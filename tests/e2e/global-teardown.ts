// Drops the database a run made for itself (playwright.config.ts), so that a development machine does not
// keep one `ekdotico_test_e2e_*` database for every run. The configuration names the database in the
// environment only when it made it; a database given by E2E_DATABASE_URL is never touched.
import { spawnSync } from 'node:child_process';

export default function teardown() {
  const name = process.env.E2E_MADE_DATABASE;
  const admin = process.env.ADMIN_DATABASE_URL;
  if (process.env.E2E_MADE_BY !== String(process.pid)) return;
  if (!name || !admin || !/^ekdotico_test_e2e_[0-9a-f]+$/.test(name)) return;
  // Only the database this run uses: a name left in the environment by an earlier run is not dropped.
  const used = process.env.E2E_DATABASE_URL ? new URL(process.env.E2E_DATABASE_URL).pathname.slice(1) : '';
  if (name !== used) return;
  const result = spawnSync(
    'psql',
    [admin, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) {
    console.error(`end-to-end database ${name} was not dropped: ${result.error?.message ?? result.stderr}`);
  }
}
