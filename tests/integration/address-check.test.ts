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
const HOUR_MS = 60 * 60 * 1000;
// An invitation stored as an earlier rule could have written it (the owner's
// decision of 12 October 2026 for the address in punycode below).
const invitation = (
  id: string,
  email: string | null,
  state: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED' = 'PENDING',
  expiresIn = 24 * HOUR_MS,
) =>
  db().admissionInvitation.create({
    data: {
      id,
      email,
      state,
      requestId: `request-${id}`,
      tokenHash: `hash-${id}`,
      expiresAt: new Date(Date.now() + expiresIn),
    },
  });
const ACCOUNTS_ZERO =
  'address check: 0 of 0 accounts hold an address that is not in its one spelling or that the rule of an address refuses';
const INVITATIONS_ZERO =
  'address check: 0 of 0 open invitations are for an address that is not in its one spelling or that the rule of an address refuses';

async function check() {
  const lines: string[] = [];
  const code = await run((line) => void lines.push(line));
  return { code, lines };
}

afterEach(async () => {
  await db().user.deleteMany();
  await db().admissionInvitation.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the check of stored addresses', () => {
  it('finds no account where every address is in its one spelling, and exits with 0', async () => {
    expect(await check()).toEqual({ code: 0, lines: [ACCOUNTS_ZERO, INVITATIONS_ZERO] });
    await account('plain', 'ada@example.com');
    await account('greek', `${of(0x3bf, 0x3b4, 0x3bf, 0x3c3)}@${of(0x3c0, 0x3b1)}.gr`);
    await account('inner', 'ada@axn--b.example');
    const { code, lines } = await check();
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^address check: 0 of 3 accounts /);
    expect(lines[1]).toBe(INVITATIONS_ZERO);
  });

  // The owner's decision of 12 October 2026 (its register row is pending).
  it('names an account whose address has a label in punycode', async () => {
    await account('puny', 'ada@xn--bcher-kva.example');
    expect(await check()).toEqual({
      code: 1,
      lines: [
        'address check: 1 of 1 accounts hold an address that is not in its one spelling or that the rule of an address refuses',
        'puny',
        INVITATIONS_ZERO,
      ],
    });
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
      INVITATIONS_ZERO,
    ]);
    const printed = lines.join('\n');
    for (const part of ['@', 'example', 'listed', 'ada', 'andre', of(0x3bf), of(0xff45)]) {
      expect(printed).not.toContain(part);
    }
  });

  it('changes no row', async () => {
    await account('sigma', FINAL_SIGMA);
    await account('wide', FULL_WIDTH);
    await invitation('puny', 'ada@xn--bcher-kva.example');
    const rows = () =>
      database.sql('SELECT id, email, "updatedAt" FROM "User" ORDER BY id') +
      database.sql(
        'SELECT id, email, state, "expiresAt", "revokedAt" FROM "AdmissionInvitation" ORDER BY id',
      );
    const before = rows();
    await check();
    expect(rows()).toBe(before);
    expect(before).toContain(FINAL_SIGMA);
    expect(before).toContain('xn--bcher-kva');
  });

  // The owner's decision of 12 October 2026 (its register row is pending): no
  // invited person meets a refusal nobody foresaw. "Open" is the admission
  // code's: pending, and not past its expiry.
  describe('the open invitations', () => {
    it('lists an open invitation for an address in punycode, by identifier alone, and exits with 1', async () => {
      await invitation('plain', 'ada@example.com');
      await invitation('puny', 'ada@xn--e1afmkfd.example');
      // An address in capitals cannot be stored: the table refuses it.
      await invitation('last', 'b@mail.xn--p1ai');
      await invitation('wide', FULL_WIDTH);
      const { code, lines } = await check();
      expect(code).toBe(1);
      expect(lines).toEqual([
        ACCOUNTS_ZERO,
        'address check: 3 of 4 open invitations are for an address that is not in its one spelling or that the rule of an address refuses',
        'last',
        'puny',
        'wide',
      ]);
      const printed = lines.join('\n');
      for (const part of ['@', 'example', 'xn--', 'listed', 'ada', of(0xff45)]) {
        expect(printed).not.toContain(part);
      }
    });

    it('does not list one that is accepted, revoked, expired, expired but still stored as pending, or cleared', async () => {
      const address = 'ada@xn--bcher-kva.example';
      await invitation('accepted', address, 'ACCEPTED');
      await invitation('revoked', address, 'REVOKED');
      await invitation('expired', address, 'EXPIRED');
      await invitation('lapsed', address, 'PENDING', -HOUR_MS);
      await invitation('cleared', null);
      expect(await check()).toEqual({
        code: 0,
        lines: [
          ACCOUNTS_ZERO,
          // Only the cleared one is open, and it holds no address to check.
          'address check: 0 of 1 open invitations are for an address that is not in its one spelling or that the rule of an address refuses',
        ],
      });
    });

    it('exits with 0 where every open invitation is for an address the rule accepts', async () => {
      await invitation('plain', 'ada@example.com');
      await invitation('inner', 'ada@axn--b.example', 'PENDING');
      expect(await check()).toEqual({
        code: 0,
        lines: [
          ACCOUNTS_ZERO,
          'address check: 0 of 2 open invitations are for an address that is not in its one spelling or that the rule of an address refuses',
        ],
      });
    });

    it('exits with 1 for an invitation alone, with no account to name', async () => {
      await account('plain', 'ada@example.com');
      await invitation('puny', 'ada@xn--bcher-kva.example');
      expect((await check()).code).toBe(1);
    });
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
    // Nor does it say that it ran where only the invitations could not be read.
    const invitationLines: string[] = [];
    expect(
      await run(
        (line) => void invitationLines.push(line),
        () => Promise.resolve([]),
        () => Promise.reject(fault),
      ),
    ).toBe(2);
    expect(invitationLines).toEqual(['address check: not run (Error P1001)']);
  });
});
