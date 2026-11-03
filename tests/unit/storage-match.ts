// Reads docs/records/storage-match.md (NFR-DP-02) and the stores it must cover. Shared by the unit and the
// integration test of the match: a store is read from the Prisma schema, the code or the database, never from a list here.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const record = readFileSync('docs/records/storage-match.md', 'utf8');

/** The rows of the first table under the heading that begins with `heading`, as arrays of cells. */
export function section(heading: string): string[][] {
  const body = record.split(/^## /m).find((part) => part.startsWith(heading));
  if (!body) throw new Error(`no section "${heading}" in storage-match.md`);
  return body
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim().replaceAll('\\_', '_').replaceAll('\\*', '*')),
    );
}

export const rowKeys = () => section('A.').map((cells) => cells[0]!);

/** A cell of the Row column: a key of section A, or `not stored`. A store with no row of §2.7 is not a state this record allows (register D270). */
export function rowIsValid(cell: string): boolean {
  return rowKeys().includes(cell) || cell === 'not stored';
}

/** The models of the Prisma schema with their scalar columns (relations are not columns). */
export function schemaColumns(): Map<string, string[]> {
  const text = readFileSync('prisma/schema.prisma', 'utf8');
  const models = [...text.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]!);
  const tables = new Map<string, string[]>();
  for (const match of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const columns: string[] = [];
    for (const line of match[2]!.split('\n')) {
      const field = /^\s{2}(\w+)\s+(\w+)(\[\])?\??/.exec(line);
      if (!field || line.trim().startsWith('//') || line.trim().startsWith('@@')) continue;
      if (models.includes(field[2]!)) continue;
      columns.push(field[1]!);
    }
    tables.set(match[1]!, columns);
  }
  return tables;
}

/** The table names and the columns the record gives each, by rows of section B. */
export function matchedColumns(): Map<string, { named: string[]; rows: string[] }> {
  const result = new Map<string, { named: string[]; rows: string[] }>();
  for (const [table, columns, row] of section('B.')) {
    const entry = result.get(table!) ?? { named: [], rows: [] };
    entry.named.push(...columns!.split(',').map((column) => column.trim()));
    entry.rows.push(row!);
    result.set(table!, entry);
  }
  return result;
}

/** Every string of the form `name:` followed by an interpolation or a quote: the prefixes of the keys a file builds, and of what it digests. */
export function valkeyPrefixes(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [
    ...new Set(
      [...text.matchAll(/[`'"]([a-z][a-z0-9]*(?:-[a-z0-9]+)*):(?=\$\{|['"`])/g)].map((match) => match[1]!),
    ),
  ].sort();
}

/** The files under src that import the Valkey client, apart from the client and the settings. */
export function valkeyFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path !== 'src/generated') walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !['src/lib/valkey.ts', 'src/lib/settings.ts'].includes(path)) {
        if (/from '(\.\.?\/)+(lib\/)?valkey(\.ts)?'/.test(readFileSync(path, 'utf8'))) found.push(path);
      }
    }
  };
  walk('src');
  return found.sort();
}

/** The names of the timers of src/lib/timers.ts, and the one that runs beside them. */
export function timerNames(): string[] {
  const text = readFileSync('src/lib/timers.ts', 'utf8');
  const listed = [...text.matchAll(/^ {2}'([a-z0-9-]+)':/gm)].map((match) => match[1]!);
  return [...listed, ...(text.includes('timer ran: document-deletion') ? ['document-deletion'] : [])].sort();
}
