// The forced re-enrolment after the database and AUTH_SECRET are both exposed (NFR-SE-17 (e); register D302, Q82 points
// 1 to 3; FR-AU-83; docs@da33e58): every second factor deleted, every password ended so that each account returns through
// a reset link, every session and link ended, a founding-team account stopped until it enrols, any other offered
// enrolment, and all of it in one transaction. Each test names the weakening that makes it fail.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPassword } from 'better-auth/crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, PASSWORD, post, prepare, signIn, sunk } from './identity.ts';
import { enrol } from './second-factor.ts';

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-exposed-mail-'));
const TEAM = 'team-member@example.com';
const database = prepare('exposed', {
  TRUSTED_PROXY_COUNT: '1',
  EMAIL_SINK_DIRECTORY: sink,
  FOUNDING_TEAM_EMAILS: TEAM,
});
// What a route hands to `after` of Next.js, kept here and run by the test.
const scheduled = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => void scheduled.push(task),
}));

const { auth, db, valkey, validateSessionRow } = await load();
const { exposure } = await import('../../scripts/rotate-auth-secret.ts');
const { listNotifications } = await import('../../src/lib/documents/sharing.ts');
const { TWO_FACTOR_OFFER_TEXT } = await import('../../src/lib/auth/enrolment-offer-text.ts');

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

const NEW = 'the-new-secret-of-a-test-with-enough-characters';
let network = 0;
const net = () => ({ 'x-forwarded-for': `10.50.${Math.floor(++network / 250)}.${network % 250}` });

async function person(email: string, twoFactor: boolean) {
  const id = await createAccount(auth, email);
  const cookie = cookiesOf(await signIn(auth, email, PASSWORD, net()));
  return { id, email, cookie, ...(twoFactor ? await enrol(auth, cookie, net()) : {}) };
}
const hashOf = async (id: string) =>
  (await db().account.findFirstOrThrow({ where: { userId: id, providerId: 'credential' } })).password!;
const state = async () => ({
  factors: await db().twoFactor.count(),
  sessions: await db().session.count(),
  hashes: (await db().account.findMany({ orderBy: { id: 'asc' }, select: { password: true } })).map(
    ({ password }) => password,
  ),
  offers: await db().notification.count({ where: { kind: 'two_factor_offer' } }),
});

/** Asks for a reset link, reads it from the sink as the person would, and sets a new password with it. */
async function resetThrough(email: string, newPassword: string) {
  const asked = await post(auth, '/request-password-reset', { email }, net());
  expect(asked.response.status).toBe(200);
  await asked.after();
  const message = (await sunk(sink)).filter((each) => each.to === email).at(-1);
  const token = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(message!.text)![1]!;
  const done = await post(auth, '/reset-password', { token, newPassword }, net());
  expect(done.response.status).toBe(200);
}

const accounts = {
  team: await person(TEAM, true),
  member: await person('member@example.com', true),
  plain: await person('plain@example.com', false),
};
const OLD_HASHES = Object.fromEntries(
  await Promise.all(Object.entries(accounts).map(async ([name, { id }]) => [name, await hashOf(id)])),
);

describe('the forced re-enrolment (NFR-SE-17 (e), D302)', () => {
  it('counts and changes nothing in a dry run', async () => {
    const before = await state();
    expect(await exposure(db(), NEW, false, [TEAM])).toEqual({
      factors: 2,
      passwords: 3,
      sessionsEnded: before.sessions,
      linksEnded: expect.any(Number),
      offered: 1,
    });
    expect(await state()).toEqual(before);
  });

  // Weakening: the deletions, the ending of the passwords and of the sessions are separate transactions.
  it('is one transaction: a fault at the last write leaves every second factor, password and session as it was', async () => {
    const before = await state();
    database.sql(
      `CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
       CREATE TRIGGER refuse_for_test BEFORE INSERT ON "Notification" FOR EACH ROW WHEN (NEW.kind = 'two_factor_offer') EXECUTE FUNCTION refuse_for_test();`,
    );
    try {
      await expect(exposure(db(), NEW, true, [TEAM])).rejects.toThrow();
    } finally {
      database.sql(`DROP TRIGGER refuse_for_test ON "Notification"; DROP FUNCTION refuse_for_test();`);
    }
    expect(await state()).toEqual(before);
    for (const [name, { id }] of Object.entries(accounts))
      expect(await hashOf(id), name).toBe(OLD_HASHES[name]);
  });

  it('refuses the same secret and a short one, and changes nothing', async () => {
    const before = await state();
    await expect(exposure(db(), NEW, true, [TEAM], NEW)).rejects.toThrow(/same/);
    await expect(exposure(db(), 'short', true, [TEAM])).rejects.toThrow(/under 32/);
    expect(await state()).toEqual(before);
  });

  it('as a command prints counts and no secret, and is refused without the list of the founding team', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: process.env.PATH!,
      NEW_AUTH_SECRET: NEW,
      DATABASE_URL: database.appUrl,
      FOUNDING_TEAM_EMAILS: TEAM,
    };
    const ran = spawnSync('node', ['scripts/rotate-auth-secret.ts', '--exposed'], { env, encoding: 'utf8' });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toMatch(
      /^rotate: dry run, nothing changed, exposed: 2 second factors deleted, 3 passwords ended, \d+ sessions ended, \d+ links ended, 1 accounts offered enrolment\n$/,
    );
    expect(ran.stdout + ran.stderr).not.toContain(NEW);
    const without = { ...env };
    delete without.FOUNDING_TEAM_EMAILS;
    const refused = spawnSync('node', ['scripts/rotate-auth-secret.ts', '--exposed'], {
      env: without,
      encoding: 'utf8',
    });
    expect(refused.status).toBe(2);
  });

  // Weakening: the second factors are re-sealed and kept (the rotation of D272), or the passwords are left.
  it('deletes every second factor, ends every password, session and link, and offers enrolment to the account that is not of the team', async () => {
    // An open link and an open second step, as an exposure would find them.
    for (const identifier of ['reset-password:link-of-the-test', 'second-step:step-of-the-test']) {
      await db().verification.create({
        data: { id: identifier, identifier, value: accounts.plain.id, expiresAt: new Date(Date.now() + 1e6) },
      });
    }
    expect(await db().verification.count()).toBeGreaterThan(0);
    const done = await exposure(db(), NEW, true, [TEAM.toUpperCase()]);
    expect(done).toMatchObject({ factors: 2, passwords: 3, offered: 1 });
    const after = await state();
    expect(after).toMatchObject({ factors: 0, sessions: 0, offers: 1 });
    expect(await db().verification.count()).toBe(0);
    expect(await db().user.count({ where: { twoFactorEnabled: true } })).toBe(0);
    // No password verifies, the old ones included, and every account holds one (FR-AU-90: none is without).
    for (const [name, { id }] of Object.entries(accounts)) {
      const hash = await hashOf(id);
      expect(hash, name).not.toBe(OLD_HASHES[name]);
      expect(await verifyPassword({ hash, password: PASSWORD }), name).toBe(false);
    }
    // Only the member who is not of the founding team and had a factor is offered.
    const offered = await db().notification.findMany({ where: { kind: 'two_factor_offer' } });
    expect(offered.map(({ recipientId }) => recipientId)).toEqual([accounts.member.id]);
  });

  it('refuses the old password at sign-in, and returns each account only through a reset link', async () => {
    for (const { email } of Object.values(accounts)) {
      const refused = await signIn(auth, email, PASSWORD, net());
      expect(refused.status, email).not.toBe(200);
    }
    const fresh = 'a new password, long enough';
    for (const { email } of Object.values(accounts)) await resetThrough(email, fresh);
    for (const { email } of Object.values(accounts)) {
      expect((await signIn(auth, email, fresh, net())).status, email).toBe(200);
    }
  });

  // Weakening: the gate of the founding team is not applied to an account that has none.
  it('stops the founding-team account until it enrols, and lets the other in with its offer', async () => {
    const fresh = 'a new password, long enough';
    const team = cookiesOf(await signIn(auth, TEAM, fresh, net()));
    const stopped = await validateSessionRow(new Headers({ cookie: team }));
    expect(stopped.session).toBeNull();
    expect(stopped.stopped).not.toBeNull();

    const member = cookiesOf(await signIn(auth, 'member@example.com', fresh, net()));
    const admitted = await validateSessionRow(new Headers({ cookie: member }));
    expect(admitted.session).not.toBeNull();
    const { notifications } = await listNotifications(accounts.member.id);
    expect(notifications.map(({ kind }) => kind)).toEqual(['two_factor_offer']);
    // The words, whole, for the owner's approval.
    expect(TWO_FACTOR_OFFER_TEXT).toBe(
      'Ekdotico reset every sign-in, so two-factor authentication is off on your account. You can turn it on again in the settings, or leave it off.',
    );
    // Nothing is offered to the team or to the account that had no factor.
    for (const { id } of [accounts.team, accounts.plain]) {
      expect((await listNotifications(id)).notifications).toEqual([]);
    }
    // To accept is to turn it on, and the offer is then gone.
    // (The enrolment itself is tests/integration/two-factor.test.ts's; here only what it leaves in the row.)
    await db().user.update({ where: { id: accounts.member.id }, data: { twoFactorEnabled: true } });
    expect((await listNotifications(accounts.member.id)).notifications).toEqual([]);
  });
});
