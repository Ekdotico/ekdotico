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
  valkeyPrefixes,
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

  // No row stands for "the rest": the columns named are exactly the columns of the table, each once.
  it.each([...schema.entries()])(
    '%s: every column is named once, and every column named is there',
    (table, columns) => {
      const entry = matched.get(table)!;
      expect(new Set(entry.named).size, 'a column is named once').toBe(entry.named.length);
      expect(
        columns.filter((column) => !entry.named.includes(column)),
        'a column of the schema that the record does not name',
      ).toEqual([]);
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

  it('the prefixes of each file are exactly those the record names for it', () => {
    for (const [file, , listed] of section('D.')) {
      if (file === 'src/lib/collab/events.ts') continue;
      const named = listed!
        .split(',')
        .map((prefix) => prefix.trim())
        .filter(Boolean)
        .sort();
      expect(valkeyPrefixes(file!), file).toEqual(named);
    }
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
  it('are matched, and are written by the sink alone', () => {
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
    const settings = readSettings() as unknown as Record<string, unknown>;
    const retention = section('G.');
    expect(retention.length).toBeGreaterThanOrEqual(6);
    for (const [name, value, row] of retention) {
      expect(settings[name!], name).toBe(Number(value));
      expect(rowIsValid(row!), name).toBe(true);
    }
    for (const [name, value, why] of section('H.')) {
      expect(settings[name!], name).toBe(Number(value));
      expect(why!.length, name).toBeGreaterThan(5);
    }
  });

  it('every numeric setting is in G or in H, once: a new period fails until it has a row', () => {
    const settings = readSettings() as unknown as Record<string, unknown>;
    const numeric = Object.keys(settings)
      .filter((name) => typeof settings[name] === 'number')
      .sort();
    const named = [...section('G.'), ...section('H.')].map((cells) => cells[0]!).sort();
    expect(named).toEqual(numeric);
  });
});
