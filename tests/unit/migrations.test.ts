import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = 'prisma/migrations';
const migrations = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// Contract IC-51, NFR-IC-16: the schema, the roles and the grants are created
// by scripts/provision.sql, and "neither migration history contains a schema, a
// role, or a grant". Prisma writes CREATE SCHEMA at the head of a generated
// migration, so this has to be checked each time.
describe('the migrations', () => {
  it('exist', () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it.each(migrations)('%s holds no schema, role, grant, or extension', (name) => {
    const sql = readFileSync(join(root, name, 'migration.sql'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(
      /\b(CREATE|ALTER|DROP)\s+(SCHEMA|ROLE|USER|EXTENSION)\b|\bGRANT\b|\bREVOKE\b|\bDEFAULT\s+PRIVILEGES\b/i,
    );
  });
});
