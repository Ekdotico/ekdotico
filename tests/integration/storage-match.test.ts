// NFR-DP-02: the match of docs/records/storage-match.md, read from a migrated database and not from the Prisma
// schema, so that a table or column made by hand in a migration is met too. And NFR-IC-17: what the backup role
// reads of what the migrations made (a table it cannot read would make the copy not whole).
import { afterAll, describe, expect, it } from 'vitest';
import { matchedColumns } from '../unit/storage-match.ts';
import { createDatabase } from './database.ts';

const database = createDatabase('match');
afterAll(() => database.drop());

function rows(sql: string): string[][] {
  return database
    .sql(sql)
    .split('\n')
    .filter((line) => line && line !== 'SET')
    .map((line) => line.split('|'));
}

describe('the tables and columns of the migrated database', () => {
  const actual = new Map<string, string[]>();
  for (const [table, column] of rows(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'ekdotico' ORDER BY table_name, ordinal_position`,
  )) {
    actual.set(table!, [...(actual.get(table!) ?? []), column!]);
  }
  const matched = matchedColumns();

  it('every table is matched, and every table matched is there', () => {
    expect([...matched.keys()].sort()).toEqual([...actual.keys()].sort());
  });

  it.each([...actual.entries()])(
    '%s: every column is matched, and every column named is there',
    (table, columns) => {
      const entry = matched.get(table)!;
      expect(entry.wildcard).toBe(true);
      expect(entry.named.filter((column) => !columns.includes(column))).toEqual([]);
    },
  );
});

describe('the backup role', () => {
  it('reads every table and sequence of the schema, and writes none (NFR-IC-17)', () => {
    const [[readable, total]] = rows(
      `SELECT count(*) FILTER (WHERE has_table_privilege('ekdotico_backup', c.oid, 'SELECT')), count(*)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ekdotico' AND c.relkind IN ('r','p')`,
    ) as [string[]];
    expect(readable).toBe(total);
    const [[writable]] = rows(
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ekdotico' AND c.relkind IN ('r','p')
          AND has_table_privilege('ekdotico_backup', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')`,
    ) as [string[]];
    expect(writable).toBe('0');
  });
});
