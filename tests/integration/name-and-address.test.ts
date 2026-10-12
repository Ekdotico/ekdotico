// The change of an account's name (FR-AU-90) and of its email address
// (FR-AU-02, FR-AU-03, FR-AU-87 (b) and (e); NFR-SE-07, the row of the
// confirmation email; NFR-SE-17 (c); the owner's answers to Q3 and Q10),
// through the identity library's handler as the route calls it, against a
// provisioned database, Valkey, and the local sink of email.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, post, prepare, signIn, sunk } from './identity.ts';
import { withCookies } from './second-factor.ts';

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-address-mail-'));
const database = prepare('address', {
  // Written as a person would write them.
  FOUNDING_TEAM_EMAILS: 'Team@Example.com , Listed@Example.com',
  TRUSTED_PROXY_COUNT: '1',
  EMAIL_SINK_DIRECTORY: sink,
});
const { auth, db, valkey, settings, validateSession, validateSessionRow } = await load();
const { findOpenAddressChange } = await import('../../src/lib/auth/name-and-address.ts');
const { beginLock } = await import('../../src/lib/auth/sign-in-lock.ts');
const { hashToken } = await import('../../src/lib/token.ts');
const { clearLimit } = await import('../../src/lib/rate-limit.ts');

// Written out here and not imported: every character is the requirement's.
// FR-AU-87 (b).
const CONFIRM_SUBJECT = 'Confirm your new email address for Ekdotico';
const CONFIRM_TEXT = (link: string) =>
  `You asked to change the email address of your Ekdotico account to this address. To confirm, open this link:\n${link}\nThe link works once and is valid for 1 hour. If you did not ask for this, you can ignore this email, and nothing changes.`;
// FR-AU-87 (e), as it reads until the contact address exists.
const NOTICE_SUBJECT = 'The email address of your Ekdotico account was changed';
const NOTICE_TEXT =
  'The email address of your Ekdotico account was changed, and this address no longer signs in to it. If you did not change it, contact the Ekdotico team.';
// FR-AU-81, at a prompt for the password (the owner's answer to Q10).
const REFUSED =
  '{"error":{"code":"password_refused","message":"The email address or the password is not correct."}}';
const UNAUTHENTICATED =
  '{"error":{"code":"unauthenticated","message":"This request needs a signed-in session. Sign in and try again."}}';
const FOREIGN =
  '{"error":{"code":"forbidden","message":"This request did not come from a page of Ekdotico and was not carried out. Open Ekdotico in the browser and try again."}}';
const INTERNAL =
  '{"error":{"code":"internal","message":"The request could not complete because of a fault on the server. Nothing was changed. Try again in a few minutes."}}';
// Text of this application, for the owner's approval.
const ASKED =
  '{"message":"Ekdotico sends a confirmation link only to an address that can become the address of this account. If the new address can, it receives an email with a link that works once and is valid for 1 hour. The address of the account stays as it is until that link is opened."}';
const NOT_VALID =
  '{"error":{"code":"address_link_not_valid","message":"This link is no longer valid. A link to confirm a new email address works once and is valid for 1 hour. Ask for a new one in the account settings."}}';

const HOUR_MS = 60 * 60 * 1000;
/** A browser without a session, and one whose cookie is of no session. */
const NO_SESSION: Record<string, string>[] = [
  {},
  { cookie: '__Secure-better-auth.session_token=made-up.c2ln' },
];
let addresses = 0;
/** A network address no earlier request came from. */
const fresh = () => ({ 'x-forwarded-for': `10.7.${Math.floor(++addresses / 250)}.${addresses % 250}` });
let people = 0;
/** An address no account has and no request has named. */
const unused = () => `new${++people}@example.com`;
/** A new account with one session, as the Cookie header of its browser. */
async function person(email = `person${++people}@example.com`) {
  const id = await createAccount(auth, email);
  const cookie = cookiesOf(await signIn(auth, email, PASSWORD, fresh()));
  const { session, stopped } = await validateSessionRow(new Headers({ cookie }));
  return { id, email, cookie, sessionId: (session ?? stopped)!.sessionId };
}
const session = async (email: string) => cookiesOf(await signIn(auth, email, PASSWORD, fresh()));
const signsIn = async (email: string, password = PASSWORD) =>
  (await signIn(auth, email, password, fresh())).status === 200;
const stands = async (cookie: string) => (await validateSessionRow(new Headers({ cookie }))).session !== null;
const rename = (cookie: string, body: unknown, headers: Record<string, string> = {}) =>
  post(auth, '/update-user', body, { cookie, ...headers });
const ask = (cookie: string, newEmail: unknown, password: unknown = PASSWORD, net = fresh()) =>
  post(auth, '/change-email', { newEmail, password }, { cookie, ...net });
const confirm = (token: unknown, headers: Record<string, string> = {}) =>
  post(auth, '/verify-email', { token }, { ...fresh(), ...headers });
const mailTo = async (email: string, subject: string) =>
  (await sunk(sink)).filter((message) => message.to === email && message.subject === subject);
const pending = (userId: string) =>
  db().verification.findMany({
    where: { identifier: { startsWith: 'confirm-address:' }, value: { startsWith: `${userId} ` } },
  });
const rowOf = (id: string) => db().user.findUniqueOrThrow({ where: { id } });
/** Asks for the change and reads the token of the link where the person would: in the email. */
async function linkFor(cookie: string, newEmail: string): Promise<string> {
  const asked = await ask(cookie, newEmail);
  expect(asked.response.status).toBe(200);
  await asked.after();
  const message = (await mailTo(newEmail.toLowerCase(), CONFIRM_SUBJECT)).at(-1);
  return /\/confirm-address\/([A-Za-z0-9_-]+)\n/.exec(message!.text)![1]!;
}
const entries = async () =>
  (await db().securityLogEntry.findMany()).map(({ kind, userId }) => [kind, userId]);

/** Holds the next call of `object[method]` before it runs (password-races.test.ts). */
function hold<T extends object>(object: T, method: keyof T & string) {
  let arrive!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  const original = (object[method] as (...args: unknown[]) => unknown).bind(object);
  vi.spyOn(object as Record<string, (...args: unknown[]) => unknown>, method).mockImplementationOnce(
    async (...args) => {
      arrive();
      await opened;
      return original(...args);
    },
  );
  return { reached, open };
}

/**
 * In the next transaction that is opened, the first call of `table.method`
 * is handed to `around`, which runs the statement itself when it calls `run`:
 * what it does before is between the transaction's earlier statements and
 * this one, and what it does after is between this one and the next.
 */
function atStatement(
  table: string,
  method: string,
  around: (run: () => Promise<unknown>) => Promise<unknown>,
) {
  type Work = (tx: Record<string, unknown>) => Promise<unknown>;
  const client = db() as unknown as { $transaction: (work: Work) => Promise<unknown> };
  const original = client.$transaction.bind(client);
  vi.spyOn(client, '$transaction').mockImplementationOnce((work) =>
    original((tx) => {
      let first = true;
      const rows = new Proxy(tx[table] as object, {
        get(target, key) {
          const statement = Reflect.get(target, key) as (...args: unknown[]) => Promise<unknown>;
          if (key !== method || !first) return statement;
          return (...args: unknown[]) => {
            first = false;
            return around(() => statement.apply(target, args));
          };
        },
      });
      return work(new Proxy(tx, { get: (target, key) => (key === table ? rows : Reflect.get(target, key)) }));
    }),
  );
}

/** Waits until a statement of this database waits for a row that another holds. */
async function untilOneWaits() {
  for (let n = 0; n < 200; n++) {
    const waiting = database.sql(
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    // The answer follows the line of the statement that sets the schema.
    if (Number(waiting.split('\n').at(-1)) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no statement came to wait');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('a change of the name (FR-AU-90)', () => {
  it('stores the name without the spaces at its ends, answers {}, and writes the signed copy again', async () => {
    const { id, cookie, sessionId } = await person();
    const done = await rename(cookie, { name: '  Ada Lovelace \n' });
    expect(done.response.status).toBe(200);
    expect(await done.response.text()).toBe('{}');
    expect(done.response.headers.get('cache-control')).toBe('no-store');
    expect((await rowOf(id)).name).toBe('Ada Lovelace');
    // The session is the one in use: its token is not set again, its copy is.
    const set = done.response.headers.getSetCookie().join('\n');
    expect(set).toContain('session_data=');
    expect(set).not.toMatch(/session_token=/);
    const browser = withCookies(cookie, done.response);
    expect((await validateSession('GET', new Headers({ cookie: browser }))).session?.sessionId).toBe(
      sessionId,
    );
  });

  // NFR-SE-08: stored as plain text, with no character removed.
  it('stores markup as the text it is, and a character as one code point', async () => {
    const { id, cookie } = await person();
    const markup = '<b onclick="x()">Ada</b> & <script>';
    expect((await rename(cookie, { name: markup })).response.status).toBe(200);
    expect((await rowOf(id)).name).toBe(markup);
    const hundred = '😀'.repeat(100);
    expect((await rename(cookie, { name: hundred })).response.status).toBe(200);
    expect((await rowOf(id)).name).toBe(hundred);
  });

  it.each([
    ['no character', ''],
    ['white space alone', ' \t\n'],
    ['101 characters', 'x'.repeat(101)],
    ['101 characters that are each two units', '😀'.repeat(101)],
    ['a control character', 'Ada\u0000Lovelace'],
    // The owner's decision of 9 October 2026 (tests/unit/field-text.test.ts has each class).
    ['a character that overrides the direction of text', `${String.fromCodePoint(0x202e)}evil`],
    ['a zero-width space alone', String.fromCodePoint(0x200b)],
    ['a blank letter alone', String.fromCodePoint(0x3164)],
    ['a line separator inside', `a${String.fromCodePoint(0x2028)}b`],
    ['a C1 control character', `a${String.fromCodePoint(0x85)}b`],
  ])('refuses a name of %s under the rule of the sign-up, and changes nothing', async (_what, name) => {
    const { id, cookie } = await person();
    const refused = await rename(cookie, { name });
    expect(refused.response.status).toBe(422);
    expect(await refused.response.json()).toEqual({
      error: {
        code: 'invalid',
        message:
          'The name was not changed, because it does not meet its rule. Change what is marked and try again.',
        fields: {
          name: 'A name has 1 to 100 characters, at least one of which can be seen, and holds no control character and no character that changes the direction of text. Enter a name of that kind.',
        },
      },
    });
    expect((await rowOf(id)).name).toBe('A Person');
  });

  // The library's own endpoint takes any column a request names.
  it.each([
    ['an address beside the name', { name: 'Ada', email: 'taken@example.com' }],
    ['a verified address', { name: 'Ada', emailVerified: true }],
    ['two-factor authentication', { name: 'Ada', twoFactorEnabled: true }],
    ['a lock', { name: 'Ada', lockedUntil: null }],
    ['no name', {}],
    ['a name that is not text', { name: 7 }],
    ['a list', ['Ada']],
  ])('refuses a body with %s, and changes no column', async (_what, body) => {
    const { id, cookie } = await person();
    const before = await rowOf(id);
    const refused = await rename(cookie, body);
    expect(refused.response.status).toBe(422);
    expect(await refused.response.json()).toEqual({
      error: { code: 'invalid_request', message: 'The request must hold a name, and nothing else.' },
    });
    expect(await rowOf(id)).toEqual(before);
  });

  it('needs a session, read from its row, and the application’s own origin', async () => {
    const { id, cookie, sessionId } = await person();
    for (const headers of NO_SESSION) {
      const refused = await post(auth, '/update-user', { name: 'Ada' }, headers);
      expect(refused.response.status).toBe(401);
      expect(await refused.response.text()).toBe(UNAUTHENTICATED);
    }
    const foreign = await rename(cookie, { name: 'Ada' }, { origin: 'https://evil.example' });
    expect(foreign.response.status).toBe(403);
    expect(await foreign.response.text()).toBe(FOREIGN);

    // Ended elsewhere: the row is gone, and the signed copy still reads.
    await db().session.delete({ where: { id: sessionId } });
    expect((await validateSession('GET', new Headers({ cookie }))).session?.userId).toBe(id);
    const ended = await rename(cookie, { name: 'Ada' });
    expect(ended.response.status).toBe(401);
    expect(await ended.response.text()).toBe(UNAUTHENTICATED);
    expect((await rowOf(id)).name).toBe('A Person');
  });

  // NFR-SE-17 (c): the row is what is asked, and never the signed copy. The
  // row is still there, so nothing but its own expiry refuses the request.
  it('is refused, as a request for a change of the address is, under a session whose row has expired and whose signed copy is fresh', async () => {
    const { id, email, cookie, sessionId } = await person();
    await db().session.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // The copy in the cookie still reads, as it does for up to a minute.
    expect((await validateSession('GET', new Headers({ cookie }))).session?.userId).toBe(id);
    for (const refused of [await rename(cookie, { name: 'Ada' }), await ask(cookie, unused())]) {
      expect(refused.response.status).toBe(401);
      expect(await refused.response.text()).toBe(UNAUTHENTICATED);
      expect(refused.left).toBe(0);
    }
    expect(await rowOf(id)).toMatchObject({ name: 'A Person', email });
    expect(await pending(id)).toEqual([]);
  });

  it('changes nothing under a session that was ended while the request was on its way', async () => {
    const { id, cookie, sessionId } = await person();
    type Work = (tx: unknown) => Promise<unknown>;
    const client = db() as unknown as { $transaction: (work: Work) => Promise<unknown> };
    const original = client.$transaction.bind(client);
    // The session ends after it was validated and before the change is made.
    vi.spyOn(client, '$transaction').mockImplementationOnce(async (work) => {
      await db().session.delete({ where: { id: sessionId } });
      return original(work);
    });
    const refused = await rename(cookie, { name: 'Ada' });
    expect(refused.response.status).toBe(401);
    expect((await rowOf(id)).name).toBe('A Person');
  });
});

describe('asking for a change of the address (FR-AU-03)', () => {
  it('sends one link to the new address, with the fixed text, after the answer, and changes nothing', async () => {
    const { id, email, cookie } = await person();
    const next = unused();
    const asked = await ask(cookie, next);
    expect(asked.response.status).toBe(200);
    expect(await asked.response.text()).toBe(ASKED);
    expect(asked.response.headers.get('cache-control')).toBe('no-store');
    expect(asked.response.headers.getSetCookie()).toEqual([]);
    // Nothing of the address was done before the answer.
    expect(await pending(id)).toEqual([]);
    expect(await mailTo(next, CONFIRM_SUBJECT)).toEqual([]);
    expect(asked.left).toBe(1);
    const before = Date.now();
    await asked.after();

    const [message, ...more] = await mailTo(next, CONFIRM_SUBJECT);
    expect(more).toEqual([]);
    const token = /\/confirm-address\/([A-Za-z0-9_-]+)\n/.exec(message!.text)![1]!;
    expect(message!.text).toBe(CONFIRM_TEXT(`${ORIGIN}/confirm-address/${token}`));
    // Nothing goes to the old address until the change takes effect.
    expect((await sunk(sink)).filter((each) => each.to === email)).toEqual([]);

    // "Until then the old address stands."
    expect(await rowOf(id)).toMatchObject({ email, emailVerified: true });
    expect(await signsIn(email)).toBe(true);
    expect(await signsIn(next)).toBe(false);

    // 256 bits, stored only as a hash, valid for 1 hour.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row, ...rows] = await pending(id);
    expect(rows).toEqual([]);
    expect(row).toMatchObject({ identifier: `confirm-address:${hashToken(token)}`, value: `${id} ${next}` });
    expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + HOUR_MS);
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + HOUR_MS);
    expect(database.sql('SELECT row_to_json(v)::text FROM "Verification" v')).not.toContain(token);
  });

  it('gives each link a token of its own', async () => {
    const tokens = new Set<string>();
    for (let n = 0; n < 5; n++) tokens.add(await linkFor((await person()).cookie, unused()));
    expect(tokens.size).toBe(5);
  });

  it('answers in the same way for an address of another account, of this account, and of the founding team, and sends them nothing', async () => {
    const other = await person();
    const { id, email, cookie } = await person();
    const free = unused();
    const answers: { status: number; body: string; headers: [string, string][]; left: number }[] = [];
    /** Whether the link the person already held still opens after each request. */
    const earlierStands: boolean[] = [];
    for (const address of [free, other.email, email, other.email.toUpperCase(), 'listed@example.com']) {
      // The person holds a link to a mailbox of their own before they ask.
      const earlier = await linkFor(cookie, unused());
      // The requests are more than the three of an hour: the count is put
      // back, so that each is answered as a first one.
      await clearLimit('CONFIRMATION_EMAIL_PER_USER', id);
      const asked = await ask(cookie, address);
      answers.push({
        status: asked.response.status,
        body: await asked.response.text(),
        headers: [...asked.response.headers].sort(),
        left: asked.left,
      });
      // Whatever depends on the address waits for the answer.
      expect((await findOpenAddressChange(earlier))?.userId).toBe(id);
      expect(await pending(id)).toHaveLength(1);
      await asked.after();
      // The earlier link is void whatever the address, so that its fate shows
      // nothing of the address; only one of the five writes a new one, the first.
      earlierStands.push((await findOpenAddressChange(earlier)) !== null);
      expect((await confirm(earlier, { cookie })).response.status).toBe(409);
      expect(await pending(id)).toHaveLength(address === free ? 1 : 0);
      await db().verification.deleteMany({ where: { value: { startsWith: `${id} ` } } });
      await clearLimit('CONFIRMATION_EMAIL_PER_USER', id);
    }
    expect(answers[0]).toEqual({ status: 200, body: ASKED, headers: expect.any(Array), left: 1 });
    for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0]);
    expect(earlierStands).toEqual([false, false, false, false, false]);

    // One email in all, to the address that could be taken.
    expect(await mailTo(free, CONFIRM_SUBJECT)).toHaveLength(1);
    for (const address of [other.email, email, 'listed@example.com']) {
      expect((await sunk(sink)).filter((message) => message.to === address)).toEqual([]);
    }
    expect((await rowOf(id)).email).toBe(email);
    expect((await rowOf(other.id)).email).toBe(other.email);
  });

  // FR-AU-03, FR-AU-83 (register A102, assumed).
  it('sends nothing and writes nothing for an account of the founding team, and answers it as any other', async () => {
    const team = await person('team@example.com');
    // With two-factor authentication on, as the gate requires of it.
    await db().user.update({ where: { id: team.id }, data: { twoFactorEnabled: true } });
    // A link from before the address came onto the list: no request of the
    // account writes one now, and this request makes it void as any other does.
    await db().verification.create({
      data: {
        id: `earlier-${team.id}`,
        identifier: `confirm-address:${'1'.repeat(64)}`,
        value: `${team.id} ${unused()}`,
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });
    const next = unused();
    const asked = await ask(team.cookie, next);
    expect(asked.response.status).toBe(200);
    expect(await asked.response.text()).toBe(ASKED);
    expect(asked.left).toBe(1);
    await asked.after();
    expect(await pending(team.id)).toEqual([]);
    expect(await mailTo(next, CONFIRM_SUBJECT)).toEqual([]);
    expect((await rowOf(team.id)).email).toBe('team@example.com');
  });

  // FR-AU-02.
  it('lowers the new address, and refuses what cannot be an address or is longer than 254 characters', async () => {
    const { id, cookie } = await person();
    const mixed = `Mixed.Case${++people}@Example.COM`;
    const token = await linkFor(cookie, mixed);
    expect((await pending(id))[0]!.value).toBe(`${id} ${mixed.toLowerCase()}`);
    expect((await confirm(token, { cookie })).response.status).toBe(200);
    expect((await rowOf(id)).email).toBe(mixed.toLowerCase());

    // FR-AU-02; the owner's decision of 9 October 2026: the one spelling of
    // an address. A Greek address in capitals that ends in sigma is the
    // address of the account that holds it in small letters, and is not taken.
    const greek = (points: number[]) => `${String.fromCodePoint(...points)}${people}@example.gr`;
    const holder = await person(greek([0x3bf, 0x3b4, 0x3bf, 0x3c3]));
    const asked = await ask(cookie, greek([0x39f, 0x394, 0x39f, 0x3a3]));
    await asked.after();
    expect(await pending(id)).toEqual([]);
    expect(await signsIn(greek([0x3bf, 0x3b4, 0x3bf, 0x3c2]))).toBe(true);
    expect((await rowOf(holder.id)).email).toBe(holder.email);

    const again = await person();
    const longest = `${'a'.repeat(242)}@example.com`;
    expect(longest).toHaveLength(254);
    for (const address of [
      `a${longest}`,
      // The owner's decision of 9 October 2026: what a header reads as more than one address.
      'x<attacker@evil.example>',
      'a@b.example,c',
      '"a"@b.example',
      'a@b.example;c@d.example',
      'a@[127.0.0.1]',
      'no-at-sign.example.com',
      'two@@example.com',
      'a space@example.com',
      'line\nbreak@example.com',
      'nodot@example',
      '',
      // The owner's decision of 9 October 2026: a domain that is not plain, or
      // not a Unicode label that normalisation leaves as it is. The first would
      // otherwise be a second address beside one on the list of the founding team.
      'listed@\u{ff45}xample.com',
      'a@example\u{b2}.com',
      'a@of\u{fb01}ce.example',
      'a@\u{24d0}xample.com',
      'a@-example.com',
      'a@example-.com',
      'a@example..com',
      `a@${'b'.repeat(64)}.com`,
    ]) {
      const refused = await ask(again.cookie, address);
      expect(refused.response.status, address).toBe(422);
      expect(await refused.response.json()).toEqual({
        error: {
          code: 'invalid',
          message:
            'The email address was not changed, because what was entered cannot be an email address. Change what is marked and try again.',
          fields: {
            newEmail: 'Enter one email address of at most 254 characters, in the form name@example.com.',
          },
        },
      });
      expect(refused.left).toBe(0);
    }
    expect(await pending(again.id)).toEqual([]);
    // 254 characters are an address.
    const kept = await ask(again.cookie, longest);
    expect(kept.response.status).toBe(200);
    await kept.after();
    expect((await pending(again.id))[0]!.value).toBe(`${again.id} ${longest}`);
  });

  // The owner, 9 October 2026: "a later request voids the earlier link".
  it('lets a later request take the place of an earlier link', async () => {
    const { id, email, cookie } = await person();
    const [mistyped, meant] = [unused(), unused()];
    const first = await linkFor(cookie, mistyped);
    const second = await linkFor(cookie, meant);
    expect(await pending(id)).toHaveLength(1);
    const late = await confirm(first, { cookie });
    expect(late.response.status).toBe(409);
    expect(await late.response.text()).toBe(NOT_VALID);
    expect((await rowOf(id)).email).toBe(email);
    expect((await confirm(second, { cookie })).response.status).toBe(200);
    expect((await rowOf(id)).email).toBe(meant);
  });

  // Were the earlier link left where nothing is sent, the person who asked
  // would read from it whether the address they named belongs to an account.
  it('makes the earlier link void by a request that sends nothing too, so that the link shows nothing of the address named', async () => {
    const other = await person();
    const { id, email, cookie } = await person();
    const first = await linkFor(cookie, unused());
    await (await ask(cookie, other.email)).after();
    expect(await findOpenAddressChange(first)).toBeNull();
    expect(await pending(id)).toEqual([]);
    const late = await confirm(first, { cookie });
    expect(late.response.status).toBe(409);
    expect(await late.response.text()).toBe(NOT_VALID);
    expect((await rowOf(id)).email).toBe(email);
  });

  it('leaves the earlier link where the request did not pass its prompt, or named no address', async () => {
    const { id, cookie } = await person();
    const first = await linkFor(cookie, unused());
    expect((await ask(cookie, unused(), 'a wrong password, long enough')).response.status).toBe(403);
    expect((await ask(cookie, 'not an address')).response.status).toBe(422);
    expect(await pending(id)).toHaveLength(1);
    expect((await confirm(first, { cookie })).response.status).toBe(200);
  });
});

describe('the current password at the request (FR-AU-03; the owner’s answer to Q10)', () => {
  it('is required: a wrong one is refused with the one statement, before anything is said of the address', async () => {
    const { id, email, cookie, sessionId } = await person();
    for (const [password, address] of [
      ['a wrong password, long enough', unused()],
      ['', unused()],
      [PASSWORD.toUpperCase(), unused()],
      ['a wrong password, long enough', 'not an address'],
    ] as const) {
      const refused = await ask(cookie, address, password);
      expect(refused.response.status).toBe(403);
      expect(await refused.response.text()).toBe(REFUSED);
      expect(refused.left).toBe(0);
    }
    expect(await pending(id)).toEqual([]);
    expect((await rowOf(id)).email).toBe(email);
    // The person stays signed in.
    expect((await validateSessionRow(new Headers({ cookie }))).session?.sessionId).toBe(sessionId);
    // NFR-SE-19: a 403, with the user and nothing else.
    expect(await entries()).toEqual(Array(4).fill(['forbidden', id]));
  });

  it('counts a wrong one as a failed sign-in, and is then refused like one, the right password included', async () => {
    const { id, email, cookie } = await person();
    const net = fresh();
    for (let n = 0; n < 5; n++) {
      expect((await ask(cookie, unused(), 'a wrong password, long enough', net)).response.status).toBe(403);
    }
    // The limit of NFR-SE-07 is reached: a sign-in from that network address
    // is refused, and so is the prompt with the right password, with no 429.
    expect((await signIn(auth, email, PASSWORD, net)).status).toBe(401);
    const held = await ask(cookie, unused(), PASSWORD, net);
    expect(held.response.status).toBe(403);
    expect(await held.response.text()).toBe(REFUSED);
    expect(held.response.headers.get('retry-after')).toBeNull();
    expect(held.left).toBe(0);
    expect(await pending(id)).toEqual([]);
    // From another network address the prompt is answered.
    expect((await ask(cookie, unused())).response.status).toBe(200);
  });

  // FR-AU-81; Q10: "a locked signed-in user is given the statement and stays signed in".
  it('is refused while the account is locked, with the same statement', async () => {
    const { id, email, cookie } = await person();
    await beginLock(email);
    const refused = await ask(cookie, unused());
    expect(refused.response.status).toBe(403);
    expect(await refused.response.text()).toBe(REFUSED);
    expect(await pending(id)).toEqual([]);
    expect(await stands(cookie)).toBe(true);
  });
});

describe('the limit of confirmation email (NFR-SE-07: 3 in any hour for each user)', () => {
  it('answers the fourth request with a 429 that states when to try again, and its entry in the security log', async () => {
    const { id, cookie } = await person();
    const stranger = await person();
    for (let n = 0; n < 3; n++) await (await ask(cookie, unused())).after();
    const fourth = await ask(cookie, unused());
    expect(fourth.response.status).toBe(429);
    const seconds = Number(fourth.response.headers.get('retry-after'));
    expect(seconds).toBeGreaterThan(3500);
    expect(seconds).toBeLessThanOrEqual(3600);
    expect(await fourth.response.json()).toEqual({
      error: {
        code: 'rate_limited',
        message: `Too many requests were made in a short time. Try again in ${seconds} seconds.`,
      },
    });
    expect(fourth.left).toBe(0);
    // Not processed: the third link is the one that stands.
    const before = await pending(id);
    await (await ask(cookie, unused())).after();
    expect(await pending(id)).toEqual(before);
    // NFR-SE-19: one entry for the period of the limit, with the user.
    expect(await entries()).toEqual([['rate_limit_reached', id]]);
    // For each user: another account is answered.
    expect((await ask(stranger.cookie, unused())).response.status).toBe(200);
  });

  it('counts a request for an address that is taken as any other, so that the limit shows nothing of it', async () => {
    const other = await person();
    const { cookie } = await person();
    for (let n = 0; n < 3; n++) expect((await ask(cookie, other.email)).response.status).toBe(200);
    expect((await ask(cookie, other.email)).response.status).toBe(429);
    expect((await ask(cookie, unused())).response.status).toBe(429);
  });

  it('counts neither a wrong password nor an address that cannot be one', async () => {
    const { cookie } = await person();
    for (let n = 0; n < 4; n++) {
      expect((await ask(cookie, unused(), 'a wrong password, long enough', fresh())).response.status).toBe(
        403,
      );
      expect((await ask(cookie, 'not an address')).response.status).toBe(422);
    }
    expect((await ask(cookie, unused())).response.status).toBe(200);
  });
});

describe('what the request for a change may say, and who may make it', () => {
  it.each([
    // The library's own fields: a place to go to, and no password. A place on
    // another origin is refused by the library before this, with a 403.
    ['a place to go to', { newEmail: 'x@example.com', password: PASSWORD, callbackURL: '/settings' }],
    ['no password', { newEmail: 'x@example.com' }],
    ['no address', { password: PASSWORD }],
    ['an address that is not text', { newEmail: ['x@example.com'], password: PASSWORD }],
    ['a user', { newEmail: 'x@example.com', password: PASSWORD, userId: 'another' }],
  ])('refuses a body with %s, and leaves nothing for after the answer', async (_what, body) => {
    const { id, cookie } = await person();
    const refused = await post(auth, '/change-email', body, { cookie, ...fresh() });
    expect(refused.response.status).toBe(422);
    expect(await refused.response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request must hold a new email address and the current password, and nothing else.',
      },
    });
    expect(refused.left).toBe(0);
    expect(await pending(id)).toEqual([]);
  });

  it('needs a session, read from its row, before anything is said of the body', async () => {
    const { id, cookie, sessionId } = await person();
    for (const headers of NO_SESSION) {
      for (const body of [{ newEmail: unused(), password: PASSWORD }, { nothing: 1 }]) {
        const refused = await post(auth, '/change-email', body, headers);
        expect(refused.response.status).toBe(401);
        expect(await refused.response.text()).toBe(UNAUTHENTICATED);
      }
    }
    const foreign = await post(
      auth,
      '/change-email',
      { newEmail: unused(), password: PASSWORD },
      { cookie, origin: 'https://evil.example' },
    );
    expect(foreign.response.status).toBe(403);
    expect(await foreign.response.text()).toBe(FOREIGN);

    await db().session.delete({ where: { id: sessionId } });
    expect((await validateSession('GET', new Headers({ cookie }))).session?.userId).toBe(id);
    const ended = await ask(cookie, unused());
    expect(ended.response.status).toBe(401);
    expect(ended.left).toBe(0);
    expect(await pending(id)).toEqual([]);
  });
});

// The owner's decision of 9 October 2026 (its register row is pending): the
// token alone confirms nothing. A new address typed wrongly would otherwise
// hand the account to whoever holds that mailbox.
describe('who may confirm a changed address (FR-AU-03; the owner’s decision of 9 October 2026)', () => {
  /** Nothing was changed, nothing ended, and the link still makes the change for the account that asked. */
  async function untouched(asker: { id: string; email: string; cookie: string }, token: string) {
    expect((await rowOf(asker.id)).email).toBe(asker.email);
    expect(await pending(asker.id)).toHaveLength(1);
    expect(await stands(asker.cookie)).toBe(true);
    expect(await entries()).toEqual([]);
    expect(await mailTo(asker.email, NOTICE_SUBJECT)).toEqual([]);
    expect((await confirm(token, { cookie: asker.cookie })).response.status).toBe(200);
  }

  it('answers 401 without a session, whatever the token, and neither changes nor spends anything', async () => {
    const asker = await person();
    const token = await linkFor(asker.cookie, unused());
    const looked = vi.spyOn(db().verification, 'findFirst');
    for (const headers of NO_SESSION) {
      for (const body of [{ token }, { token: 'x'.repeat(43) }, { nothing: 1 }]) {
        const refused = await post(auth, '/verify-email', body, { ...fresh(), ...headers });
        expect(refused.response.status).toBe(401);
        expect(await refused.response.text()).toBe(UNAUTHENTICATED);
        expect(refused.left).toBe(0);
      }
    }
    // Authorisation first: the link was not looked at.
    expect(looked).not.toHaveBeenCalled();
    await untouched(asker, token);
  });

  it('answers a session of another account as a link that is not valid, and neither changes nor spends anything', async () => {
    const asker = await person();
    const stranger = await person();
    const token = await linkFor(asker.cookie, unused());
    const refused = await confirm(token, { cookie: stranger.cookie });
    expect(refused.response.status).toBe(409);
    expect(await refused.response.text()).toBe(NOT_VALID);
    expect(refused.left).toBe(0);
    // The same answer, to the byte, as to a token that is not known.
    const unknown = await confirm('x'.repeat(43), { cookie: stranger.cookie });
    expect(unknown.response.status).toBe(409);
    expect([...refused.response.headers].sort()).toEqual([...unknown.response.headers].sort());
    // Nothing of the other account either.
    expect((await rowOf(stranger.id)).email).toBe(stranger.email);
    expect(await stands(stranger.cookie)).toBe(true);
    await untouched(asker, token);
  });

  it('is made under any session of the account: one on a second device confirms', async () => {
    const { id, email, cookie } = await person();
    const second = await session(email);
    const next = unused();
    const token = await linkFor(cookie, next);
    expect((await confirm(token, { cookie: second })).response.status).toBe(200);
    expect((await rowOf(id)).email).toBe(next);
    expect(await stands(second)).toBe(true);
    expect(await stands(cookie)).toBe(false);
  });

  it('is refused under a session whose row has ended or expired, though its signed copy is fresh', async () => {
    for (const end of ['ended', 'expired'] as const) {
      const { id, email, cookie, sessionId } = await person();
      const other = await session(email);
      const token = await linkFor(cookie, unused());
      if (end === 'ended') await db().session.delete({ where: { id: sessionId } });
      else {
        await db().session.update({
          where: { id: sessionId },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      }
      expect((await validateSession('GET', new Headers({ cookie }))).session?.userId).toBe(id);
      const refused = await confirm(token, { cookie });
      expect(refused.response.status, end).toBe(401);
      expect(await refused.response.text()).toBe(UNAUTHENTICATED);
      expect((await rowOf(id)).email).toBe(email);
      expect(await pending(id)).toHaveLength(1);
      expect(await stands(other)).toBe(true);
    }
  });

  it('changes nothing under a session that was ended while the confirmation was on its way, and spends nothing', async () => {
    const { id, email, cookie, sessionId } = await person();
    const other = await session(email);
    const token = await linkFor(cookie, unused());
    type Work = (tx: unknown) => Promise<unknown>;
    const client = db() as unknown as { $transaction: (work: Work) => Promise<unknown> };
    const original = client.$transaction.bind(client);
    vi.spyOn(client, '$transaction').mockImplementationOnce(async (work) => {
      await db().session.delete({ where: { id: sessionId } });
      return original(work);
    });
    const refused = await confirm(token, { cookie });
    expect(refused.response.status).toBe(401);
    expect(await refused.response.text()).toBe(UNAUTHENTICATED);
    expect(refused.left).toBe(0);
    expect((await rowOf(id)).email).toBe(email);
    expect(await stands(other)).toBe(true);
    // Undone whole: the link is as it was.
    expect((await confirm(token, { cookie: other })).response.status).toBe(200);
  });

  // FR-AU-83 (register A102, assumed): the gate is asked before the link.
  it('answers 403 to an account that the founding-team gate stops, with its entry', async () => {
    const team = await person('listed@example.com');
    const refused = await confirm('x'.repeat(43), { cookie: team.cookie });
    expect(refused.response.status).toBe(403);
    expect((await refused.response.json()).error.code).toBe('two_factor_required');
    expect(await entries()).toEqual([['forbidden', team.id]]);
  });
});

describe('the confirmation of a changed address (FR-AU-03; the owner’s answer to Q3)', () => {
  it('makes the change, answers {}, makes no session, and sends the notice to the old address after the answer', async () => {
    const { id, email, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    const done = await confirm(token, { cookie });
    expect(done.response.status).toBe(200);
    expect(await done.response.text()).toBe('{}');
    expect(done.response.headers.get('cache-control')).toBe('no-store');
    // The session in use stays, and no other is made.
    expect(done.response.headers.getSetCookie().join('\n')).not.toMatch(/session_token=/);
    expect(await db().session.count({ where: { userId: id } })).toBe(1);

    expect(await rowOf(id)).toMatchObject({ email: next, emailVerified: true });
    // "This address no longer signs in to it."
    expect(await signsIn(email)).toBe(false);
    expect(await signsIn(next)).toBe(true);
    expect(await pending(id)).toEqual([]);

    expect(await mailTo(email, NOTICE_SUBJECT)).toEqual([]);
    expect(done.left).toBe(1);
    await done.after();
    const notices = await mailTo(email, NOTICE_SUBJECT);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toBe(NOTICE_TEXT);
    // The new address is told nothing more.
    expect(await mailTo(next, NOTICE_SUBJECT)).toEqual([]);
  });

  it('changes nothing when the page of the link is read, however often', async () => {
    const { id, email, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    const before = await pending(id);
    for (let n = 0; n < 3; n++) {
      expect(await findOpenAddressChange(token)).toEqual({
        id: before[0]!.id,
        userId: id,
        oldEmail: email,
        newEmail: next,
      });
    }
    expect(await pending(id)).toEqual(before);
    expect((await rowOf(id)).email).toBe(email);
    expect(await stands(cookie)).toBe(true);
    expect((await confirm(token, { cookie })).response.status).toBe(200);
  });

  it('ends every session but that of the browser that confirms, and none of another account, and writes its signed copy again', async () => {
    const { id, email, cookie, sessionId } = await person();
    const others = [await session(email), await session(email)];
    const stranger = await person();
    const next = unused();
    const token = await linkFor(others[0]!, next);
    const done = await confirm(token, { cookie });
    expect(done.response.status).toBe(200);

    expect((await db().session.findMany({ where: { userId: id } })).map((row) => row.id)).toEqual([
      sessionId,
    ]);
    for (const each of others) {
      expect(await stands(each)).toBe(false);
      // Refused at once by a request that changes state.
      expect((await rename(each, { name: 'Ada' })).response.status).toBe(401);
    }
    expect(await stands(stranger.cookie)).toBe(true);
    // The token of the session is not set again; its copy is, with the new address.
    const set = done.response.headers.getSetCookie().join('\n');
    expect(set).toContain('session_data=');
    expect(set).not.toMatch(/session_token=/);
    const browser = withCookies(cookie, done.response);
    const { response } = await auth().api.getSession({
      headers: new Headers({ cookie: browser }),
      returnHeaders: true,
    });
    expect(response?.user.email).toBe(next);
    expect(response?.session.id).toBe(sessionId);
  });

  it('works once: a second confirmation is refused, and changes nothing more', async () => {
    const { id, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    expect((await confirm(token, { cookie })).response.status).toBe(200);
    const kept = await session(next);

    const again = await confirm(token, { cookie });
    expect(again.response.status).toBe(409);
    expect(await again.response.text()).toBe(NOT_VALID);
    expect(again.left).toBe(0);
    expect(again.response.headers.getSetCookie()).toEqual([]);
    // No session is ended by a link that is spent.
    expect(await stands(kept)).toBe(true);
    expect((await rowOf(id)).email).toBe(next);
    expect(await findOpenAddressChange(token)).toBeNull();
  });

  it('works once under confirmations sent together: one makes the change, and one notice is sent', async () => {
    const { id, email, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    const sent = await Promise.all(Array.from({ length: 6 }, () => confirm(token, { cookie })));
    const statuses = sent.map((each) => each.response.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
    for (const each of sent) await each.after();
    // One of the six left a notice for after its answer.
    expect(sent.reduce((sum, each) => sum + each.left, 0)).toBe(1);
    expect(await mailTo(email, NOTICE_SUBJECT)).toHaveLength(1);
    expect((await rowOf(id)).email).toBe(next);
  });

  it('is valid for 1 hour and no longer', async () => {
    const { id, email, cookie } = await person();
    const token = await linkFor(cookie, unused());
    const [row] = await pending(id);
    expect(await findOpenAddressChange(token, new Date(row!.expiresAt.getTime() - 1))).not.toBeNull();
    expect(await findOpenAddressChange(token, row!.expiresAt)).toBeNull();

    await db().verification.update({
      where: { id: row!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const late = await confirm(token, { cookie });
    expect(late.response.status).toBe(409);
    expect(await late.response.text()).toBe(NOT_VALID);
    expect((await rowOf(id)).email).toBe(email);
    expect(await stands(cookie)).toBe(true);
    // NFR-RE-15: the timer removes it.
    const { deleteExpiredTokens } = await import('../../src/lib/auth/password.ts');
    expect(await deleteExpiredTokens()).toBeGreaterThanOrEqual(1);
    expect(await pending(id)).toEqual([]);
  });

  it('gives one answer to a token that is not known, is no token, or belongs to another kind of link', async () => {
    const { email, cookie } = await person();
    await linkFor(cookie, unused());
    const asked = await post(auth, '/request-password-reset', { email }, fresh());
    await asked.after();
    const reset = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(
      (await mailTo(email, 'Set a new password for Ekdotico')).at(-1)!.text,
    )![1]!;
    for (const token of ['x'.repeat(43), 'short', '', `${'x'.repeat(42)}%`, reset]) {
      const refused = await confirm(token, { cookie });
      expect(refused.response.status, token).toBe(409);
      expect(await refused.response.text()).toBe(NOT_VALID);
    }
    for (const body of [{}, { token: 7 }, { token: 'x'.repeat(43), userId: 'another' }, ['x']]) {
      const refused = await post(auth, '/verify-email', body, { cookie, ...fresh() });
      expect(refused.response.status).toBe(422);
      expect(await refused.response.json()).toEqual({
        error: {
          code: 'invalid_request',
          message: 'The request must hold the token of a link, and nothing else.',
        },
      });
    }
  });

  // NFR-SE-17 (c): the library checks the origin only of a request with a
  // cookie, so the endpoint checks it itself, first, with a session or without.
  it('is refused from another origin and without one, before the token is read, and changes nothing', async () => {
    const { id, email, cookie } = await person();
    const token = await linkFor(cookie, unused());
    const looked = vi.spyOn(db().verification, 'findFirst');
    for (const origin of ['https://evil.example', 'null', `${ORIGIN}.evil.example`, '']) {
      for (const sent of [{ cookie }, {}] as Record<string, string>[]) {
        const refused = await confirm(token, { ...sent, origin });
        expect(refused.response.status, origin).toBe(403);
        expect(await refused.response.text()).toBe(FOREIGN);
      }
    }
    expect(looked).not.toHaveBeenCalled();
    expect((await rowOf(id)).email).toBe(email);
    expect(await pending(id)).toHaveLength(1);
    expect(await stands(cookie)).toBe(true);
  });
});

describe('what a change of the address makes void (FR-AU-03, FR-AU-81, FR-AU-86)', () => {
  it('makes void the reset links, the second steps, and the sign-in link of a lock, of this account alone', async () => {
    const { id, email, cookie } = await person();
    const stranger = await person();
    const token = await linkFor(cookie, unused());
    // Outstanding for each account: a reset link, a step, and the link of a lock.
    for (const each of [
      { id, email },
      { id: stranger.id, email: stranger.email },
    ]) {
      await (await post(auth, '/request-password-reset', { email: each.email }, fresh())).after();
      await db().verification.create({
        data: {
          id: `step-${each.id}`,
          identifier: `second-step:${'0'.repeat(64)}${each.id}`,
          value: each.id,
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      await beginLock(each.email);
    }
    const kinds = async (userId: string) =>
      (await db().verification.findMany({ where: { value: userId } }))
        .map((row) => row.identifier.slice(0, row.identifier.indexOf(':')))
        .sort();
    expect(await kinds(id)).toEqual(['reset-password', 'second-step', 'sign-in-link']);
    const reset = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(
      (await mailTo(email, 'Set a new password for Ekdotico')).at(-1)!.text,
    )![1]!;
    const lock = /\/sign-in\/link\/([A-Za-z0-9_-]+)\n/.exec(
      (await sunk(sink)).filter((m) => m.to === email && /locked/.test(m.subject ?? '')).at(-1)!.text,
    )![1]!;

    expect((await confirm(token, { cookie })).response.status).toBe(200);

    expect(await kinds(id)).toEqual([]);
    expect(await kinds(stranger.id)).toEqual(['reset-password', 'second-step', 'sign-in-link']);
    // The reset link that was mailed to the old address sets no password.
    const late = await post(auth, '/reset-password', { token: reset, newPassword: 'another password, long' });
    expect(late.response.status).toBe(409);
    // The link of the lock signs no one in. The lock itself stays (FR-AU-81:
    // only its hour, a completed reset and its own link end it).
    expect((await post(auth, '/sign-in/link', { token: lock }, fresh())).response.status).toBe(409);
    expect((await rowOf(id)).lockedUntil).not.toBeNull();
  });

  it('makes void every other pending change of the account, one written beside it included', async () => {
    const { id, cookie } = await person();
    const stranger = await person();
    const token = await linkFor(cookie, unused());
    const theirs = await linkFor(stranger.cookie, unused());
    // As a request that was answered at the same moment writes it.
    await db().verification.create({
      data: {
        id: `beside-${id}`,
        identifier: `confirm-address:${'0'.repeat(64)}`,
        value: `${id} ${unused()}`,
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });
    expect((await confirm(token, { cookie })).response.status).toBe(200);
    expect(await pending(id)).toEqual([]);
    expect(await pending(stranger.id)).toHaveLength(1);
    expect((await confirm(theirs, { cookie: stranger.cookie })).response.status).toBe(200);
  });

  it('is itself made void by a change of the password, and by a completed reset', async () => {
    const changer = await person();
    const first = await linkFor(changer.cookie, unused());
    const changed = await post(
      auth,
      '/change-password',
      { currentPassword: PASSWORD, newPassword: 'a new password, long enough' },
      { cookie: changer.cookie, ...fresh() },
    );
    expect(changed.response.status).toBe(200);
    expect(await pending(changer.id)).toEqual([]);
    // The session that changed the password stays (FR-AU-85), and confirms nothing.
    const refused = await confirm(first, { cookie: changer.cookie });
    expect(refused.response.status).toBe(409);
    expect(await refused.response.text()).toBe(NOT_VALID);
    expect((await rowOf(changer.id)).email).toBe(changer.email);

    const resetter = await person();
    const stranger = await person();
    const second = await linkFor(resetter.cookie, unused());
    const theirs = await linkFor(stranger.cookie, unused());
    await (await post(auth, '/request-password-reset', { email: resetter.email }, fresh())).after();
    const reset = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(
      (await mailTo(resetter.email, 'Set a new password for Ekdotico')).at(-1)!.text,
    )![1]!;
    expect(
      (await post(auth, '/reset-password', { token: reset, newPassword: 'a new password, long enough' }))
        .response.status,
    ).toBe(200);
    // The reset ended every session: under a new one, with the new password.
    const again = cookiesOf(await signIn(auth, resetter.email, 'a new password, long enough', fresh()));
    expect((await confirm(second, { cookie: again })).response.status).toBe(409);
    expect((await rowOf(resetter.id)).email).toBe(resetter.email);
    // The link of another account still makes its change.
    expect((await confirm(theirs, { cookie: stranger.cookie })).response.status).toBe(200);
  });

  it('leaves the pending change as it was where a change of the password is refused', async () => {
    const { id, cookie } = await person();
    const token = await linkFor(cookie, unused());
    const refused = await post(
      auth,
      '/change-password',
      { currentPassword: 'a wrong password, long enough', newPassword: 'a new password, long enough' },
      { cookie, ...fresh() },
    );
    expect(refused.response.status).toBe(403);
    expect(await pending(id)).toHaveLength(1);
    expect((await confirm(token, { cookie })).response.status).toBe(200);
  });
});

describe('a confirmation on its way while its link is made void (FR-AU-03)', () => {
  /** Runs `between` after the confirmation has read its link and before it makes the change. */
  function beforeTheChange(between: () => Promise<unknown>) {
    type Work = (tx: unknown) => Promise<unknown>;
    const client = db() as unknown as { $transaction: (work: Work) => Promise<unknown> };
    const original = client.$transaction.bind(client);
    vi.spyOn(client, '$transaction').mockImplementationOnce(async (work) => {
      await between();
      return original(work);
    });
  }

  it('changes nothing where the link was deleted after it was read: the claim finds nothing', async () => {
    const { id, email, cookie } = await person();
    const other = await session(email);
    const token = await linkFor(cookie, unused());
    // As a change of the password, or a later request, deletes it.
    beforeTheChange(() => db().verification.deleteMany({ where: { value: { startsWith: `${id} ` } } }));
    const refused = await confirm(token, { cookie });
    expect(refused.response.status).toBe(409);
    expect(await refused.response.text()).toBe(NOT_VALID);
    expect(refused.left).toBe(0);
    expect((await rowOf(id)).email).toBe(email);
    expect(await stands(other)).toBe(true);
  });

  // The read of the link asks its hour, and so does the claim, of its own:
  // only the second is in the transaction that makes the change.
  it('changes nothing where the hour of the link passed after it was read: the claim asks the time itself', async () => {
    const { id, email, cookie } = await person();
    const other = await session(email);
    const token = await linkFor(cookie, unused());
    beforeTheChange(() =>
      db().verification.updateMany({
        where: { value: { startsWith: `${id} ` } },
        data: { expiresAt: new Date(Date.now() - 1) },
      }),
    );
    const refused = await confirm(token, { cookie });
    expect(refused.response.status).toBe(409);
    expect(await refused.response.text()).toBe(NOT_VALID);
    expect(refused.left).toBe(0);
    expect((await rowOf(id)).email).toBe(email);
    expect(await stands(other)).toBe(true);
    expect(await entries()).toEqual([]);
  });

  it('changes nothing where the password was set after the link was read, and leaves the link as it was', async () => {
    const { id, email, cookie } = await person();
    const token = await linkFor(cookie, unused());
    // As a reset writes it, some statements before it makes this link void.
    beforeTheChange(async () => {
      const context = await auth().$context;
      await db().account.updateMany({
        where: { userId: id },
        data: { password: await context.password.hash('a password set meanwhile') },
      });
    });
    const refused = await confirm(token, { cookie });
    expect(refused.response.status).toBe(409);
    expect(await refused.response.text()).toBe(NOT_VALID);
    expect((await rowOf(id)).email).toBe(email);
    expect(await stands(cookie)).toBe(true);
    // Undone whole: the transaction spent nothing.
    expect(await pending(id)).toHaveLength(1);
  });
});

describe('an address that can no longer be taken when the link is opened (FR-AU-03)', () => {
  it('is never taken where it has come to belong to another account: a refusal, and nothing changed', async () => {
    const { id, email, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    // An account is created with the address before the link is opened.
    await createAccount(auth, next);
    expect(await findOpenAddressChange(token)).toBeNull();
    const refused = await confirm(token, { cookie });
    expect(refused.response.status).toBe(409);
    expect(await refused.response.text()).toBe(NOT_VALID);
    expect(refused.left).toBe(0);
    expect((await rowOf(id)).email).toBe(email);
    expect(await stands(cookie)).toBe(true);
    expect(await mailTo(email, NOTICE_SUBJECT)).toEqual([]);
  });

  it('is refused by the unique index where the account was created at that moment: no fault, and the transaction undone', async () => {
    const { id, email, cookie } = await person();
    const other = await session(email);
    const next = unused();
    const token = await linkFor(cookie, next);
    await (await post(auth, '/request-password-reset', { email }, fresh())).after();
    await createAccount(auth, next);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The read that would have found the other account finds none: it was created just after.
    const count = vi.spyOn(db().user, 'count');
    count.mockResolvedValueOnce(0 as never);

    const refused = await confirm(token, { cookie });
    expect(refused.response.status).toBe(409);
    expect(await refused.response.text()).toBe(NOT_VALID);
    expect(errors).not.toHaveBeenCalled();
    // Undone whole: the address, the sessions, the reset link, and the link itself.
    expect((await rowOf(id)).email).toBe(email);
    expect(await stands(cookie)).toBe(true);
    expect(await stands(other)).toBe(true);
    expect(await db().verification.count({ where: { value: id } })).toBe(1);
    expect(await pending(id)).toHaveLength(1);
    // NFR-SE-19: and the entry of the change, which did not take effect.
    expect(await entries()).toEqual([]);
    expect(await signsIn(email)).toBe(true);
  });

  // "The list is checked again when the link is opened" (register A102, assumed).
  it('is refused where the new address, or the account, has come onto the list of the founding team', async () => {
    const list = settings().foundingTeamEmails as string[];
    const { id, email, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    try {
      // As the processes would read it after a restart with a new list.
      list.push(next);
      expect(await findOpenAddressChange(token)).toBeNull();
      expect((await confirm(token, { cookie })).response.status).toBe(409);
      list.pop();
      list.push(email);
      expect(await findOpenAddressChange(token)).toBeNull();
      // The account is now one that the gate stops (FR-AU-83): its session
      // confirms nothing, and is answered as the gate answers.
      const refused = await confirm(token, { cookie });
      expect(refused.response.status).toBe(403);
      expect((await refused.response.json()).error.code).toBe('two_factor_required');
    } finally {
      list.pop();
    }
    expect((await rowOf(id)).email).toBe(email);
    // The list as it was: the link, which nothing spent, makes the change.
    expect((await confirm(token, { cookie })).response.status).toBe(200);
  });

  it('is refused for an account whose address is no longer the one the link was asked under', async () => {
    const { id, cookie } = await person();
    const token = await linkFor(cookie, unused());
    const moved = unused();
    // Held where the change is made: the account has been read by then.
    type Work = (tx: unknown) => Promise<unknown>;
    const client = db() as unknown as { $transaction: (work: Work) => Promise<unknown> };
    const original = client.$transaction.bind(client);
    vi.spyOn(client, '$transaction').mockImplementationOnce(async (work) => {
      await db().user.update({ where: { id }, data: { email: moved } });
      return original(work);
    });
    expect((await confirm(token, { cookie })).response.status).toBe(409);
    expect((await rowOf(id)).email).toBe(moved);
    // Undone: the link was not spent by the attempt.
    expect(await pending(id)).toHaveLength(1);
  });
});

describe('a sign-in with the old address on its way (FR-AU-03: "this address no longer signs in to it")', () => {
  it('leaves no session where the change was confirmed after the password was checked', async () => {
    const { id, email, cookie, sessionId } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    const held = hold((await auth().$context).internalAdapter, 'createSession');

    const signing = signIn(auth, email, PASSWORD, fresh());
    await held.reached;
    expect((await confirm(token, { cookie })).response.status).toBe(200);
    // The session that confirmed, and no other.
    const kept = async () => (await db().session.findMany({ where: { userId: id } })).map((row) => row.id);
    expect(await kept()).toEqual([sessionId]);
    held.open();
    const signed = await signing;

    expect(signed.status).toBe(401);
    expect(await signed.text()).toBe(
      '{"error":{"code":"sign_in_refused","message":"The email address or the password is not correct."}}',
    );
    expect(signed.headers.getSetCookie()).toEqual([]);
    expect(await kept()).toEqual([sessionId]);
    expect(await signsIn(next)).toBe(true);
  });

  it('leaves no second step where the account has two-factor authentication on', async () => {
    const { id, email, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    await db().user.update({ where: { id }, data: { twoFactorEnabled: true } });
    const held = hold((await auth().$context).password, 'verify');

    const signing = signIn(auth, email, PASSWORD, fresh());
    await held.reached;
    expect((await confirm(token, { cookie })).response.status).toBe(200);
    held.open();
    const signed = await signing;

    expect(signed.status).toBe(401);
    expect(await db().verification.count({ where: { value: id } })).toBe(0);
    // The cookie of the step that was begun is cleared again.
    expect(withCookies('', signed)).not.toContain('two_factor');
  });
});

describe('the counts of failed sign-ins, and the lock, at a change of the address (NFR-SE-07, FR-AU-81)', () => {
  it('leaves the lock on the account, and clears no count: the change is no way round either', async () => {
    const { id, email, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    await beginLock(email);
    const until = (await rowOf(id)).lockedUntil;
    expect(until).not.toBeNull();
    expect((await confirm(token, { cookie })).response.status).toBe(200);
    expect((await rowOf(id)).lockedUntil).toEqual(until);
    // Locked under its new address as it was under the old.
    expect(await signsIn(next)).toBe(false);
  });
});

describe('an endpoint that leaves work for after its answer, called where none can be left (FR-AU-87)', () => {
  it('fails before anything is written or counted, so that the answer of a fault is true', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id, email, cookie } = await person();
    const token = await linkFor(cookie, unused());
    const bare = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      auth().handler(
        new Request(`${ORIGIN}/api/auth${path}`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json', ...fresh(), ...headers },
          body: JSON.stringify(body),
        }),
      );
    const asked = vi.spyOn(valkey(), 'eval');
    for (const response of [
      await bare('/verify-email', { token }, { cookie }),
      await bare('/change-email', { newEmail: unused(), password: PASSWORD }, { cookie }),
    ]) {
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(INTERNAL);
    }
    expect(asked).not.toHaveBeenCalled();
    expect((await rowOf(id)).email).toBe(email);
    expect(await pending(id)).toHaveLength(1);
    expect(await stands(cookie)).toBe(true);
  });
});

describe('a lock or a reset begun for the old address beside the confirmation (FR-AU-03: "this address no longer signs in to it")', () => {
  const LOCKED = /^Sign-in to your Ekdotico account is locked/;
  const RESET_SUBJECT = 'Set a new password for Ekdotico';
  const resetRows = (userId: string) =>
    db().verification.count({ where: { value: userId, identifier: { startsWith: 'reset-password:' } } });

  it('begins no lock, writes no link and sends nothing where the address was changed after the lock read the account', async () => {
    const { id, email, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    let confirmed = 0;
    // The confirmation commits between the lock's read of the account by its
    // old address and the statement that begins the lock.
    atStatement('user', 'findUnique', async (run) => {
      const found = await run();
      confirmed = (await confirm(token, { cookie })).response.status;
      return found;
    });
    await beginLock(email);

    expect(confirmed).toBe(200);
    expect(await rowOf(id)).toMatchObject({ email: next, lockedUntil: null });
    expect(await db().verification.count({ where: { value: id } })).toBe(0);
    expect(
      (await sunk(sink)).filter((m) => LOCKED.test(m.subject ?? '') && [email, next].includes(m.to!)),
    ).toEqual([]);
    // NFR-SE-19: no entry says a lock began.
    expect(await entries()).toEqual([['address_changed', id]]);
    expect(await signsIn(next)).toBe(true);
  });

  it('writes no reset link and sends nothing where the address was changed after the reset read the account', async () => {
    const { id, email, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    const asked = await post(auth, '/request-password-reset', { email }, fresh());
    let confirmed = 0;
    // The account is read by its old address, and the change commits before the link is written.
    const users = db().user as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const read = users.findUnique!.bind(users);
    vi.spyOn(users, 'findUnique').mockImplementationOnce(async (...args) => {
      const found = await read(...args);
      confirmed = (await confirm(token, { cookie })).response.status;
      return found;
    });
    await asked.after();

    expect(confirmed).toBe(200);
    expect((await rowOf(id)).email).toBe(next);
    expect(await resetRows(id)).toBe(0);
    for (const address of [email, next]) expect(await mailTo(address, RESET_SUBJECT)).toEqual([]);
  });

  it('leaves no reset link that was written while the confirmation was on its way: the link mailed to the old address sets no password', async () => {
    const { id, email, cookie } = await person();
    const next = unused();
    const token = await linkFor(cookie, next);
    const asked = await post(auth, '/request-password-reset', { email }, fresh());
    let confirming!: ReturnType<typeof confirm>;
    // The reset holds the row of the account and has written its link, not
    // yet committed: the confirmation has deleted the reset links it could
    // see, and waits for the row of the account.
    atStatement('verification', 'create', async (run) => {
      const written = await run();
      confirming = confirm(token, { cookie });
      await untilOneWaits();
      return written;
    });
    await asked.after();
    expect((await confirming).response.status).toBe(200);

    expect((await rowOf(id)).email).toBe(next);
    expect(await resetRows(id)).toBe(0);
    // The email had left for the old address; its link is void.
    const mailed = (await mailTo(email, RESET_SUBJECT)).at(-1);
    const reset = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(mailed!.text)![1]!;
    const late = await post(auth, '/reset-password', {
      token: reset,
      newPassword: 'the old mailbox sets this',
    });
    expect(late.response.status).toBe(409);
    expect(await signsIn(next)).toBe(true);
    expect(await signsIn(next, 'the old mailbox sets this')).toBe(false);
  });
});

describe('the entry of a change of the address in the security log (NFR-SE-19; the owner’s decision S9)', () => {
  it('writes one entry for a change that took effect, with the user and nothing else', async () => {
    const { id, cookie } = await person();
    const token = await linkFor(cookie, unused());
    expect(await entries()).toEqual([]);
    expect((await confirm(token, { cookie })).response.status).toBe(200);
    expect(await db().securityLogEntry.findMany()).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(Date),
        kind: 'address_changed',
        userId: id,
        documentId: null,
      },
    ]);
    // A link that is spent writes no second one.
    expect((await confirm(token, { cookie })).response.status).toBe(409);
    expect((await entries()).filter(([kind]) => kind === 'address_changed')).toHaveLength(1);
  });

  it('writes one entry where the confirmations arrive together', async () => {
    const { id, cookie } = await person();
    const token = await linkFor(cookie, unused());
    await Promise.all(Array.from({ length: 6 }, () => confirm(token, { cookie })));
    expect(await entries()).toEqual([['address_changed', id]]);
  });

  it('writes none for a link that is not known, void, or expired', async () => {
    const { id, cookie } = await person();
    const first = await linkFor(cookie, unused());
    const second = await linkFor(cookie, unused());
    await db().verification.updateMany({
      where: { value: { startsWith: `${id} ` } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    for (const token of ['x'.repeat(43), first, second]) {
      expect((await confirm(token, { cookie })).response.status).toBe(409);
    }
    expect(await entries()).toEqual([]);
  });

  it('writes the entry in the transaction of the change: no change without its entry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id, email, cookie } = await person();
    const other = await session(email);
    const token = await linkFor(cookie, unused());
    atStatement('securityLogEntry', 'create', () => Promise.reject(new Error('the entry was not written')));
    const failed = await confirm(token, { cookie });
    expect(failed.response.status).toBe(500);
    expect(failed.left).toBe(0);
    expect((await rowOf(id)).email).toBe(email);
    expect(await stands(other)).toBe(true);
    expect(await entries()).toEqual([]);
    // The link was not spent by the fault.
    expect((await confirm(token, { cookie })).response.status).toBe(200);
    expect(await entries()).toEqual([['address_changed', id]]);
  });

  it('leaves no entry of a change that did not take effect: a transaction that fails after the entry undoes it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id, email, cookie } = await person();
    const token = await linkFor(cookie, unused());
    atStatement('securityLogEntry', 'create', async (run) => {
      await run();
      throw new Error('not committed');
    });
    expect((await confirm(token, { cookie })).response.status).toBe(500);
    expect((await rowOf(id)).email).toBe(email);
    // An entry written outside the transaction would be here (R38).
    expect(await entries()).toEqual([]);
  });
});

describe('what is logged (NFR-SE-19)', () => {
  it('writes nothing to the console, and no address, name or token anywhere', async () => {
    const { cookie } = await person();
    const next = unused();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');

    await rename(cookie, { name: 'A Name To Look For' });
    await rename(cookie, { name: '' });
    await ask(cookie, next, 'a wrong password, long enough');
    const asked = await ask(cookie, next);
    await asked.after();
    const token = /\/confirm-address\/([A-Za-z0-9_-]+)\n/.exec(
      (await mailTo(next, CONFIRM_SUBJECT)).at(-1)!.text,
    )![1]!;
    await confirm('x'.repeat(43));
    const done = await confirm(token, { cookie });
    await done.after();
    await confirm(token, { cookie });

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    const stored = database.sql('SELECT row_to_json(e)::text FROM "SecurityLogEntry" e');
    for (const secret of [token, next, 'example.com', 'A Name To Look For', PASSWORD]) {
      expect(stored).not.toContain(secret);
    }
  });
});
