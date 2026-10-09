// The one-off check of stored addresses (scripts/check-addresses.ts; the
// owner's decision of 9 October 2026), against a provisioned database that
// holds rows as an earlier rule would have stored them.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { load, prepare } from './identity.ts';

const database = prepare('addresscheck');
const { db, valkey } = await load();
const { run } = await import('../../scripts/check-addresses.ts');

const of = (...points: number[]) => String.fromCodePoint(...points);
// A Greek address stored with the final sigma, and one with a full-width letter in its domain.
const FINAL_SIGMA = `${of(0x3bf, 0x3b4, 0x3bf, 0x3c2)}@example.gr`;
const FULL_WIDTH = `listed@${of(0xff45)}xample.com`;
const account = (id: string, email: string) => db().user.create({ data: { id, name: 'A Person', email } });

async function check() {
  const lines: string[] = [];
  const code = await run((line) => void lines.push(line));
  return { code, lines };
}

afterEach(async () => {
  await db().user.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the check of stored addresses', () => {
  it('finds no account where every address is in its one spelling, and exits with 0', async () => {
    expect(await check()).toEqual({
      code: 0,
      lines: [
        'address check: 0 of 0 accounts hold an address that is not in its one spelling or that the rule of an address refuses',
      ],
    });
    await account('plain', 'ada@example.com');
    await account('greek', `${of(0x3bf, 0x3b4, 0x3bf, 0x3c3)}@${of(0x3c0, 0x3b1)}.gr`);
    await account('punycode', 'ada@xn--bcher-kva.example');
    const { code, lines } = await check();
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^address check: 0 of 3 accounts /);
  });

  it('counts and names by identifier the accounts stored otherwise, exits with 1, and prints no address (NFR-SE-19)', async () => {
    await account('plain', 'ada@example.com');
    await account('sigma', FINAL_SIGMA);
    await account('wide', FULL_WIDTH);
    // An address in capitals cannot be stored: the table refuses it (User_email_lower_case).
    await account('decomposed', 'andre\u{301}@example.com');
    await account('hyphen', 'ada@example-.com');
    const { code, lines } = await check();
    expect(code).toBe(1);
    expect(lines).toEqual([
      'address check: 4 of 5 accounts hold an address that is not in its one spelling or that the rule of an address refuses',
      'decomposed',
      'hyphen',
      'sigma',
      'wide',
    ]);
    const printed = lines.join('\n');
    for (const part of ['@', 'example', 'listed', 'ada', 'andre', of(0x3bf), of(0xff45)]) {
      expect(printed).not.toContain(part);
    }
  });

  it('changes no row', async () => {
    await account('sigma', FINAL_SIGMA);
    await account('wide', FULL_WIDTH);
    const before = database.sql('SELECT id, email, "updatedAt" FROM "User" ORDER BY id');
    await check();
    expect(database.sql('SELECT id, email, "updatedAt" FROM "User" ORDER BY id')).toBe(before);
    expect(before).toContain(FINAL_SIGMA);
  });

  it('says that it did not run, with the class of the fault and no more, and exits with 2', async () => {
    const lines: string[] = [];
    const fault = Object.assign(new Error(`no row for ${FULL_WIDTH}`), { code: 'P1001' });
    expect(
      await run(
        (line) => void lines.push(line),
        () => Promise.reject(fault),
      ),
    ).toBe(2);
    expect(lines).toEqual(['address check: not run (Error P1001)']);
  });
});
