// FR-AU-82; the owner's decision of 8 October 2026: the list that ships is a
// published one of at least 100,000 known-compromised passwords of 8
// characters or more, recorded with its name, version, source and licence.
// This reads the file that ships, through the check every page calls.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

const FILE = 'data/common-passwords.txt';
const lines = readFileSync(FILE, 'utf8').split('\n');
const first = lines.findIndex((line) => !line.startsWith('#'));
const heading = lines.slice(0, first).join('\n');
const entries = lines.slice(first).filter((line) => line !== '');

vi.doMock('../../src/lib/settings.ts', () => ({
  settings: () => ({ passwordMinLength: 8, passwordMaxLength: 32, passwordListFile: FILE }),
}));
const { checkPassword } = await import('../../src/lib/password-rules.ts');
afterAll(() => vi.doUnmock('../../src/lib/settings.ts'));

const EMAIL = 'ada.lovelace@example.com';

describe('the list of known passwords that ships', () => {
  it('holds at least 100,000 entries, as many as its heading says', () => {
    expect(entries.length).toBeGreaterThanOrEqual(100_000);
    expect(heading).toContain(`${entries.length} entries.`);
  });

  it('is recorded with its name, version, source and licence, here and beside it', () => {
    const record = readFileSync('data/common-passwords.md', 'utf8');
    const version = /^# Version: commit ([0-9a-f]{40}) /m.exec(heading)?.[1];
    expect(version).toBeDefined();
    expect(heading).toMatch(/^# SecLists, /);
    expect(heading).toMatch(
      new RegExp(`^# Source: https://raw\\.githubusercontent\\.com/.+/${version}/`, 'm'),
    );
    expect(heading).toMatch(/^# Licence: MIT /m);
    expect(heading).toMatch(/^# Filter /m);
    expect(record).toContain(version);
    expect(record).toContain('Copyright (c) 2018 Daniel Miessler');
    expect(record).toContain('Mark Burnett (xato.net)');
    expect(record).toContain(`${entries.length.toLocaleString('en-GB')} of the source`);
  });

  it('holds each entry once, in the form it is compared in, of a length a password can have', () => {
    expect(new Set(entries).size).toBe(entries.length);
    for (const entry of entries) {
      const length = [...entry].length;
      if (
        entry !== entry.normalize('NFKC').toLowerCase() ||
        length < 8 ||
        length > 32 ||
        /\p{Cc}/u.test(entry)
      ) {
        // The place and not the entry: an entry is never printed.
        throw new Error(`Entry ${entries.indexOf(entry) + 1} of the list is not in the form of its filter.`);
      }
    }
  });

  it('refuses the well-known passwords of 8 characters or more, in any case and any width', () => {
    for (const known of [
      'password1',
      'password123',
      '12345678',
      'qwertyuiop',
      'PassWord1',
      'ｐａｓｓｗｏｒｄ１',
    ]) {
      expect(checkPassword(known, EMAIL), known).toMatch(/list of commonly used and known-compromised/);
    }
  });

  it('refuses no password made at random', () => {
    for (let i = 0; i < 20; i++) expect(checkPassword(randomBytes(12).toString('base64'), EMAIL)).toBeNull();
    expect(checkPassword('a long and private phrase', EMAIL)).toBeNull();
  });
});
