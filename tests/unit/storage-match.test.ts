// NFR-DP-02; the build-phases page, "the storage matched to the retention schedule": every table, column,
// prefix, family of Valkey keys, directory of the sink and timer is matched in docs/records/storage-match.md to a
// row of §2.7. Each test reads the store from the schema or the code, so a new one fails here until it is matched.
import { describe, expect, it } from 'vitest';
import { BACKUP_PREFIX } from '../../scripts/backup.ts';
import { newObjectKey } from '../../src/lib/images/storage.ts';
import { loadSettings } from '../../src/lib/settings.ts';
import {
  matchedColumns,
  rowIsValid,
  rowKeys,
  schemaColumns,
  section,
  timerNames,
  valkeyFiles,
} from './storage-match.ts';

describe('the rows of the retention schedule that the record uses', () => {
  it('are unique, and each has an excerpt and a retention', () => {
    const rows = section('A.');
    expect(new Set(rowKeys()).size).toBe(rows.length);
    for (const [key, excerpt, retention] of rows) {
      expect(excerpt!.length, key).toBeGreaterThan(10);
      expect(retention!.length, key).toBeGreaterThan(5);
    }
  });
});

describe('the tables and columns of the Prisma schema', () => {
  const schema = schemaColumns();
  const matched = matchedColumns();

  it('every model is matched, and every table matched is a model (the migration table apart)', () => {
    expect([...matched.keys()].filter((table) => table !== '_prisma_migrations').sort()).toEqual(
      [...schema.keys()].sort(),
    );
  });

  it.each([...schema.entries()])(
    '%s: every column is matched once, and none that is named is missing',
    (table, columns) => {
      const entry = matched.get(table)!;
      expect(entry.wildcard, `${table} has a row for the rest of its columns`).toBe(true);
      expect(new Set(entry.named).size, 'a column is named once').toBe(entry.named.length);
      expect(
        entry.named.filter((column) => !columns.includes(column)),
        'named but not a column',
      ).toEqual([]);
      expect(columns.length).toBeGreaterThan(0);
    },
  );

  it('every row named is a row of the schedule or a stated gap', () => {
    for (const [table, entry] of matched)
      for (const row of entry.rows) expect(rowIsValid(row), `${table}: ${row}`).toBe(true);
    for (const [, , row] of [...section('C.'), ...section('F.')].map((cells) => [
      cells[0],
      cells[1],
      cells[cells.length === 4 ? 2 : 1],
    ])) {
      expect(rowIsValid(row!), String(row)).toBe(true);
    }
  });
});

describe('the object storage prefixes', () => {
  it('are the prefix of an image key and the prefix of a copy, and no other', () => {
    const matchedPrefixes = section('C.').map((cells) => cells[0]!.replaceAll('`', ''));
    const inCode = [newObjectKey('3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b').split('/')[0]!, BACKUP_PREFIX];
    expect(matchedPrefixes.sort()).toEqual(inCode.sort());
  });
});

describe('Valkey', () => {
  it('every file that uses it is matched, and every file matched uses it', () => {
    const matched = section('D.').map((cells) => cells[0]!);
    expect(matched.sort()).toEqual(valkeyFiles());
  });
});

describe('the timers', () => {
  it('every timer is matched, and every timer matched exists', () => {
    expect(
      section('F.')
        .map((cells) => cells[0]!)
        .sort(),
    ).toEqual(timerNames());
  });
});

describe('the files of the email sink', () => {
  it('are matched while the sink is the only sender', () => {
    const settings = readSettings();
    expect(settings.emailSinkDirectory).toBeTruthy();
    expect(section('E.')).toHaveLength(1);
  });
});

function readSettings() {
  return loadSettings({
    FOUNDING_TEAM_EMAILS: '',
    APP_ORIGIN: 'https://app.example.test',
    EMAIL_TRANSPORT: 'sink',
    EMAIL_SINK_DIRECTORY: '/var/lib/ekdotico/mail',
    DATABASE_URL: 'postgresql://ekdotico_app:x@localhost:5432/ekdotico',
    VALKEY_URL: 'redis://localhost:6379',
    AUTH_SECRET: 'a-test-secret-of-at-least-thirty-two-characters',
    TRUSTED_PROXY_COUNT: '1',
  });
}

describe('the periods that are settings (NFR-DP-02: validated against §2.7)', () => {
  it('are the periods the record states, which are those of §2.7', () => {
    const settings = readSettings() as unknown as Record<string, number>;
    const rows = section('G.');
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const [name, value, row] of rows) {
      expect(settings[name!], name).toBe(Number(value));
      expect(rowIsValid(row!), name).toBe(true);
    }
  });
});
