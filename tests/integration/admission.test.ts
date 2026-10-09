// The three admission endpoints and the command that calls them (FR-AU-57,
// FR-AU-89; NFR-SE-05 (b), NFR-SE-07, NFR-SE-19), through their route
// handlers, against a provisioned database and Valkey. The wire format itself
// is tested in tests/unit/admission-signature.test.ts.
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccount, load, ORIGIN, prepare } from './identity.ts';

// `after` of Next.js runs a task once the response has been returned, and
// exists only inside a request of the framework. Here the tasks are kept, so
// that a test can see what was done before the response and what after it.
const later = vi.hoisted(() => ({ tasks: [] as (() => unknown)[] }));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.tasks.push(task),
}));

// The hand-over itself is tested in tests/unit/email-hand-over.test.ts: here it
// runs as it is, and what the route gave it is kept.
const handedOver = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../src/lib/email/hand-over.ts', async (original) => {
  const actual = await original<typeof import('../../src/lib/email/hand-over.ts')>();
  return {
    handOver: (...args: Parameters<typeof actual.handOver>) => {
      handedOver.calls.push(args);
      return actual.handOver(...args);
    },
  };
});

const SECRET = 'an-admission-secret-for-the-tests-0123456789_-';
const sink = mkdtempSync(join(tmpdir(), 'ekdotico-admission-'));
const database = prepare('admission', { ADMISSION_SECRET: SECRET, EMAIL_SINK_DIRECTORY: sink });
const { auth, db, valkey, settings } = await load();
const { clearLimit } = await import('../../src/lib/rate-limit.ts');
const { signedHeaders, SIGNATURE_HEADER, TIMESTAMP_HEADER } =
  await import('../../src/lib/admission/signature.ts');
const { findOpenInvitation } = await import('../../src/lib/admission/invitations.ts');
const collection = await import('../../src/app/api/admission/invitations/route.ts');
const item = await import('../../src/app/api/admission/invitations/[id]/route.ts');
const { run } = await import('../../scripts/admission.ts');

const PATH = '/api/admission/invitations';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sends a request to the handler of its method, as Next.js would. */
function send(request: Request): Promise<Response> {
  if (request.method === 'POST') return collection.POST(request);
  if (request.method === 'GET') return collection.GET(request);
  return item.DELETE(request);
}

/** A request signed as the contract page says, unless `headers` says otherwise. */
function signed(method: string, path: string, json?: unknown, headers?: Record<string, string>) {
  const body = json === undefined ? undefined : new TextEncoder().encode(JSON.stringify(json));
  return new Request(ORIGIN + path, {
    method,
    headers: headers ?? signedHeaders(SECRET, method, path, body),
    body,
  });
}

let requests = 0;
const requestId = () => `request-${++requests}`;
const create = (email: string, id = requestId()) => send(signed('POST', PATH, { email, requestId: id }));
const list = async () =>
  (await (await send(signed('GET', PATH))).json()).invitations as Record<string, unknown>[];
const revoke = (id: string) => send(signed('DELETE', `${PATH}/${id}`));

/** Runs what the handlers left for after the response. */
async function afterResponse() {
  for (const task of later.tasks.splice(0)) await task();
}
const mail = () => readdirSync(sink).map((name) => readFileSync(join(sink, name), 'utf8'));
/** The token of the one link in a message. */
const tokenIn = (message: string | undefined) => /\/sign-up\/([A-Za-z0-9_-]+)/.exec(message ?? '')![1]!;
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
const logged = (kind: string) => db().securityLogEntry.findMany({ where: { kind } });
const mark = (name: string) =>
  `limit-logged:${createHmac('sha256', process.env.AUTH_SECRET!).update(`admission:${name}`).digest('hex')}`;

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error)).toEqual(['code', 'message']);
  expect(body.error.code).toBe(code);
  return body.error.message as string;
}

beforeEach(async () => {
  await clearLimit('ADMISSION', 'all');
  await valkey().del(mark('signature_invalid'), mark('admission_limit'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  later.tasks.length = 0;
  handedOver.calls.length = 0;
  for (const name of readdirSync(sink)) rmSync(join(sink, name));
  await db().securityLogEntry.deleteMany();
  await db().admissionInvitation.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
  rmSync(sink, { recursive: true, force: true });
});

describe('a request whose signature does not verify (NFR-SE-05 (b))', () => {
  const body = { email: 'person@example.com', requestId: 'r-1' };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const old = () => signedHeaders(SECRET, 'POST', PATH, bytes, Date.now() - 301_000);
  const refusals: [string, () => Request][] = [
    ['no headers', () => signed('POST', PATH, body, {})],
    ['another secret', () => signed('POST', PATH, body, signedHeaders(`${SECRET}x`, 'POST', PATH, bytes))],
    ['a time more than 5 minutes old (a replay)', () => signed('POST', PATH, body, old())],
    [
      'a body altered after signing',
      () =>
        signed(
          'POST',
          PATH,
          { ...body, email: 'other@example.com' },
          signedHeaders(SECRET, 'POST', PATH, bytes),
        ),
    ],
    [
      'the signature of another method',
      () => signed('POST', PATH, body, signedHeaders(SECRET, 'GET', PATH, bytes)),
    ],
    [
      'upper-case hexadecimal',
      () => {
        const headers = signedHeaders(SECRET, 'POST', PATH, bytes);
        return signed('POST', PATH, body, {
          ...headers,
          [SIGNATURE_HEADER]: headers[SIGNATURE_HEADER]!.toUpperCase(),
        });
      },
    ],
    ['a query string', () => signed('GET', `${PATH}?all=1`, undefined, signedHeaders(SECRET, 'GET', PATH))],
    [
      'a list without a signature',
      () => signed('GET', PATH, undefined, { [TIMESTAMP_HEADER]: '1791450000' }),
    ],
    ['a revocation without a signature', () => signed('DELETE', `${PATH}/abc`, undefined, {})],
    [
      'a revocation signed for another invitation',
      () => signed('DELETE', `${PATH}/abc`, undefined, signedHeaders(SECRET, 'DELETE', `${PATH}/abd`)),
    ],
  ];

  it.each(refusals)('is rejected before any processing: %s', async (_, request) => {
    // What a verified request would have changed or returned.
    await create('held@example.com');
    await afterResponse();
    const [held] = await list();
    const before = mail().length;

    const response = await send(request());
    await expectError(response, 401, 'unauthorised');
    await afterResponse();

    expect(await db().admissionInvitation.count()).toBe(1);
    expect((await list())[0]).toEqual(held);
    expect(mail().length).toBe(before);
    expect(later.tasks.length).toBe(0);
  });

  it('is answered the same whichever check failed', async () => {
    const answers = new Set<string>();
    for (const [, request] of refusals) answers.add(await (await send(request())).text());
    expect(answers.size).toBe(1);
    expect([...answers][0]).not.toMatch(/person@example\.com|expired|replay|timestamp|body|header/i);
  });

  it('is written to the security log as a bad signature, with nothing of a person (NFR-SE-19)', async () => {
    await send(signed('POST', PATH, body, {}));
    const entries = await logged('signature_invalid');
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ userId: null, documentId: null });
  });

  it('writes one entry for a minute of rejections, not one for each', async () => {
    for (let n = 0; n < 8; n++) await send(signed('GET', PATH, undefined, {}));
    expect((await logged('signature_invalid')).length).toBe(1);
    // The next minute has its own.
    await valkey().del(mark('signature_invalid'));
    await send(signed('GET', PATH, undefined, {}));
    expect((await logged('signature_invalid')).length).toBe(2);
  });

  it('writes one entry a minute from this process where Valkey cannot keep the mark', async () => {
    vi.spyOn(valkey(), 'set').mockRejectedValue(new Error('ECONNREFUSED redis://secret@host'));
    const now = Date.now.bind(Date);
    let passed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now() + passed);
    for (let n = 0; n < 8; n++) {
      await expectError(await send(signed('GET', PATH, undefined, {})), 401, 'unauthorised');
    }
    // A log too full, never one too empty: the entry is written, and once.
    expect((await logged('signature_invalid')).length).toBe(1);
    passed = 59_000;
    await send(signed('GET', PATH, undefined, {}));
    expect((await logged('signature_invalid')).length).toBe(1);
    // The next minute has its own.
    passed = 61_000;
    for (let n = 0; n < 3; n++) await send(signed('GET', PATH, undefined, {}));
    expect((await logged('signature_invalid')).length).toBe(2);
  });

  it('is every request, where no admission secret is configured', async () => {
    const live = settings() as { admissionSecret: string | undefined };
    live.admissionSecret = undefined;
    try {
      await expectError(await create('person@example.com'), 401, 'unauthorised');
      await expectError(await send(signed('GET', PATH)), 401, 'unauthorised');
      // Not even a request signed with the empty key.
      const empty = signedHeaders('', 'GET', PATH);
      await expectError(await send(signed('GET', PATH, undefined, empty)), 401, 'unauthorised');
    } finally {
      live.admissionSecret = SECRET;
    }
    expect(await db().admissionInvitation.count()).toBe(0);
  });
});

describe('create (FR-AU-89 (a))', () => {
  it('creates one pending invitation that expires 30 days on, and returns neither token nor link', async () => {
    const started = Date.now();
    const response = await create('person@example.com');
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    const invitation = JSON.parse(text);
    expect(Object.keys(invitation)).toEqual(['id', 'email', 'state', 'createdAt', 'expiresAt']);
    expect(invitation.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(invitation.email).toBe('person@example.com');
    expect(invitation.state).toBe('pending');
    expect(invitation.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(invitation.createdAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt)).toBe(30 * DAY_MS);

    await afterResponse();
    const token = tokenIn(mail()[0]);
    expect(text).not.toContain(token);
    expect(text).not.toContain(hashOf(token));
    expect(text).not.toContain('sign-up');
  });

  it('stores the token only as a hash, and the token is at least 128 bits', async () => {
    await create('person@example.com');
    await afterResponse();
    const token = tokenIn(mail()[0]);
    // 43 characters of the URL-safe alphabet: 256 bits.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = database.sql('SELECT row_to_json(i)::text FROM "AdmissionInvitation" i');
    expect(stored).not.toContain(token);
    // Read as the administrator, after the `SET` that `sql` prints.
    expect(JSON.parse(stored.slice(stored.indexOf('{'))).tokenHash).toBe(hashOf(token));
    // A second invitation has another token.
    await create('second@example.com');
    await afterResponse();
    expect(new Set(mail().map(tokenIn)).size).toBe(2);
  });

  it('hands the email of FR-AU-87 (a) over after the response, with its fixed text', async () => {
    const response = await create('person@example.com');
    expect(response.status).toBe(201);
    // The response exists, and nothing has been handed over yet.
    expect(mail()).toEqual([]);
    expect(later.tasks.length).toBe(1);
    await afterResponse();

    const [message] = mail();
    expect(mail().length).toBe(1);
    const [head, text] = message!.split('\n\n');
    expect(head).toContain('To: person@example.com');
    expect(head).toContain('Subject: Your invitation to Ekdotico Closed α');
    const token = tokenIn(text);
    expect(text).toBe(
      `The Ekdotico team has invited you to test Ekdotico in Closed α. To create your account, open this link and choose a password:\n${ORIGIN}/sign-up/${token}\nThe link works once and is valid for 30 days. If you did not expect this invitation, you can ignore this email.`,
    );
    expect(await findOpenInvitation(token)).toEqual({ email: 'person@example.com' });
  });

  it('names the invitation, and nothing of a person, to the hand-over for its log line (NFR-SE-19)', async () => {
    const { id } = await (await create('person@example.com')).json();
    await afterResponse();
    expect(handedOver.calls).toHaveLength(1);
    expect(handedOver.calls[0]![1]).toBe(`invitation ${id}`);
  });

  it('stores the address in lower case (FR-AU-02)', async () => {
    const invitation = await (await create('Person@Example.COM')).json();
    expect(invitation.email).toBe('person@example.com');
    await afterResponse();
    expect(mail()[0]).toContain('To: person@example.com');
  });

  it('changes nothing where the request identifier is repeated, and answers the same', async () => {
    const first = await create('person@example.com', 'the-same-request');
    const firstText = await first.text();
    await afterResponse();
    const token = tokenIn(mail()[0]);

    const again = await create('person@example.com', 'the-same-request');
    expect(again.status).toBe(201);
    expect(await again.text()).toBe(firstText);
    // Without regard to the case of the address, which is one address.
    expect((await create('PERSON@example.com', 'the-same-request')).status).toBe(201);
    await afterResponse();

    expect(await db().admissionInvitation.count()).toBe(1);
    expect(mail().length).toBe(1);
    expect(await findOpenInvitation(token)).toEqual({ email: 'person@example.com' });
  });

  it('refuses a repeated request identifier that names another address', async () => {
    await create('person@example.com', 'the-same-request');
    await expectError(await create('other@example.com', 'the-same-request'), 422, 'invalid');
    await afterResponse();
    expect(await db().admissionInvitation.count()).toBe(1);
    expect(mail().length).toBe(1);
  });

  // The order of the lookups: the request identifier first, the account after.
  it('answers a repeat sent after its invitation was accepted as the first, and not as an existing account', async () => {
    const first = await (await create('joined@example.com', 'the-same-request')).json();
    await db().admissionInvitation.update({ where: { id: first.id }, data: { state: 'ACCEPTED' } });
    await createAccount(auth, 'joined@example.com');

    const again = await create('joined@example.com', 'the-same-request');
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ ...first, state: 'accepted' });
    await afterResponse();
    expect(await db().admissionInvitation.count()).toBe(1);
    expect(mail().length).toBe(1);
    // A new request for that address is the one that is told of the account.
    await expectError(await create('joined@example.com'), 409, 'account_exists');
  });

  it('answers a repeat as the invitation now stands', async () => {
    const { id } = await (await create('person@example.com', 'the-same-request')).json();
    await revoke(id);
    const again = await (await create('person@example.com', 'the-same-request')).json();
    expect(again.state).toBe('revoked');
    expect(await db().admissionInvitation.count()).toBe(1);
  });

  it('revokes a pending invitation to the same address and replaces it, with a new link', async () => {
    const first = await (await create('person@example.com')).json();
    await afterResponse();
    const oldToken = tokenIn(mail()[0]);

    const second = await (await create('person@example.com')).json();
    await afterResponse();
    const newToken = mail()
      .map(tokenIn)
      .find((token) => token !== oldToken)!;

    expect(second.id).not.toBe(first.id);
    const states = Object.fromEntries((await list()).map((each) => [each.id, each.state]));
    expect(states).toEqual({ [first.id]: 'revoked', [second.id]: 'pending' });
    // The old link creates nothing; the new one is open.
    expect(await findOpenInvitation(oldToken)).toBeNull();
    expect(await findOpenInvitation(newToken)).toEqual({ email: 'person@example.com' });
    const revoked = await db().admissionInvitation.findUniqueOrThrow({ where: { id: first.id } });
    expect(revoked.revokedAt).not.toBeNull();
  });

  it('writes an invitation past its expiry as expired, not revoked, when it is replaced', async () => {
    const first = await (await create('person@example.com')).json();
    await db().admissionInvitation.update({
      where: { id: first.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const second = await (await create('person@example.com')).json();
    expect(second.state).toBe('pending');
    const old = await db().admissionInvitation.findUniqueOrThrow({ where: { id: first.id } });
    expect(old.state).toBe('EXPIRED');
    expect(old.revokedAt).toBeNull();
  });

  it('leaves one pending invitation where several requests for one address arrive at once', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => create('person@example.com')));
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(201));
    const states = (await list()).map((each) => each.state);
    expect(states.length).toBe(6);
    expect(states.filter((state) => state === 'pending').length).toBe(1);
    expect(states.filter((state) => state === 'revoked').length).toBe(5);
  });

  it('refuses a second pending invitation for one address in the database itself', async () => {
    await create('person@example.com');
    await expect(
      db().admissionInvitation.create({
        data: { email: 'person@example.com', requestId: 'by-hand', tokenHash: 'x', expiresAt: new Date() },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('creates one invitation where one request arrives twice at once', async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => create('person@example.com', 'sent-at-once')),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(4).fill(201));
    expect(new Set(await Promise.all(responses.map((response) => response.text()))).size).toBe(1);
    expect(await db().admissionInvitation.count()).toBe(1);
    await afterResponse();
    expect(mail().length).toBe(1);
  });

  it('creates nothing for the address of an existing account, and says so', async () => {
    await createAccount(auth, 'member@example.com');
    const message = await expectError(await create('Member@Example.com'), 409, 'account_exists');
    expect(message).toContain('already belongs to an account');
    await afterResponse();
    expect(await db().admissionInvitation.count()).toBe(0);
    expect(mail()).toEqual([]);
  });

  it.each([
    ['no address', { requestId: 'r' }],
    ['no request identifier', { email: 'person@example.com' }],
    ['an address that is not one', { email: 'person.example.com', requestId: 'r' }],
    ['an address with a space', { email: 'per son@example.com', requestId: 'r' }],
    ['an address with a line break', { email: 'person@example.com\nBcc: other@example.com', requestId: 'r' }],
    ['an address that is not text', { email: ['person@example.com'], requestId: 'r' }],
    ['a request identifier with another character', { email: 'person@example.com', requestId: 'r 1' }],
    ['a request identifier of 65 characters', { email: 'person@example.com', requestId: 'r'.repeat(65) }],
    ['an empty request identifier', { email: 'person@example.com', requestId: '' }],
    ['a list', [{ email: 'person@example.com', requestId: 'r' }]],
    ['null', null],
  ])('answers 422 to a verified request with %s', async (_, body) => {
    await expectError(await send(signed('POST', PATH, body)), 422, 'invalid');
    await afterResponse();
    expect(await db().admissionInvitation.count()).toBe(0);
    expect(mail()).toEqual([]);
  });

  it('answers 422 to a verified body that is not JSON', async () => {
    const body = new TextEncoder().encode('email=person@example.com');
    const request = new Request(ORIGIN + PATH, {
      method: 'POST',
      headers: signedHeaders(SECRET, 'POST', PATH, body),
      body,
    });
    await expectError(await send(request), 422, 'invalid');
  });
});

describe('list (FR-AU-89 (b))', () => {
  it('returns every invitation with its five fields, and never token, hash, or link', async () => {
    await create('first@example.com');
    await create('second@example.com');
    await create('third@example.com');
    await afterResponse();
    const response = await send(signed('GET', PATH));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    const { invitations } = JSON.parse(text);
    expect(invitations.map((each: { email: string }) => each.email)).toEqual([
      'first@example.com',
      'second@example.com',
      'third@example.com',
    ]);
    for (const each of invitations) {
      expect(Object.keys(each)).toEqual(['id', 'email', 'state', 'createdAt', 'expiresAt']);
    }
    for (const token of mail().map(tokenIn)) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(hashOf(token));
    }
    expect(text).not.toMatch(/sign-up|token|hash|requestId/i);
  });

  it('shows the four states, the expired one by its time alone', async () => {
    const ids: Record<string, string> = {};
    for (const state of ['pending', 'accepted', 'revoked', 'expired']) {
      ids[state] = (await (await create(`${state}@example.com`)).json()).id;
    }
    await db().admissionInvitation.update({ where: { id: ids.accepted }, data: { state: 'ACCEPTED' } });
    await revoke(ids.revoked!);
    // Still stored as pending: no timer has touched it.
    await db().admissionInvitation.update({
      where: { id: ids.expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const states = Object.fromEntries((await list()).map((each) => [each.email, each.state]));
    expect(states).toEqual({
      'pending@example.com': 'pending',
      'accepted@example.com': 'accepted',
      'revoked@example.com': 'revoked',
      'expired@example.com': 'expired',
    });
  });

  it('leaves the address out once it has been cleared', async () => {
    const { id } = await (await create('person@example.com')).json();
    await db().admissionInvitation.update({ where: { id }, data: { state: 'REVOKED', email: null } });
    const [invitation] = await list();
    expect(Object.keys(invitation!)).toEqual(['id', 'state', 'createdAt', 'expiresAt']);
  });
});

describe('revoke (FR-AU-89 (c))', () => {
  it('revokes a pending invitation, whose link then creates nothing', async () => {
    const { id } = await (await create('person@example.com')).json();
    await afterResponse();
    const token = tokenIn(mail()[0]);
    expect(await findOpenInvitation(token)).not.toBeNull();

    const response = await revoke(id);
    expect(response.status).toBe(200);
    const invitation = await response.json();
    expect(Object.keys(invitation)).toEqual(['id', 'email', 'state', 'createdAt', 'expiresAt']);
    expect(invitation).toMatchObject({ id, email: 'person@example.com', state: 'revoked' });
    expect(await findOpenInvitation(token)).toBeNull();
    const row = await db().admissionInvitation.findUniqueOrThrow({ where: { id } });
    // The time from which the 30 days to the clearing of the address are counted.
    expect(Date.now() - row.revokedAt!.getTime()).toBeLessThan(60_000);
  });

  it('succeeds again for an invitation that is revoked already', async () => {
    const { id } = await (await create('person@example.com')).json();
    const first = await (await revoke(id)).text();
    const again = await revoke(id);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(first);
  });

  it('answers 404 where no invitation has the identifier', async () => {
    await expectError(await revoke('no-such-invitation'), 404, 'not_found');
  });

  it('answers 409 for an invitation that is accepted or expired, and changes neither', async () => {
    const accepted = (await (await create('accepted@example.com')).json()).id;
    const expired = (await (await create('expired@example.com')).json()).id;
    await db().admissionInvitation.update({ where: { id: accepted }, data: { state: 'ACCEPTED' } });
    await db().admissionInvitation.update({
      where: { id: expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expectError(await revoke(accepted), 409, 'not_pending');
    await expectError(await revoke(expired), 409, 'not_pending');
    const states = Object.fromEntries((await list()).map((each) => [each.email, each.state]));
    expect(states).toEqual({ 'accepted@example.com': 'accepted', 'expired@example.com': 'expired' });
  });
});

describe('the limit of 60 requests in any minute, in all (NFR-SE-07)', () => {
  it('answers the 61st verified request with 429 and when to try again, and does not process it', async () => {
    for (let n = 0; n < 59; n++) expect((await send(signed('GET', PATH))).status).toBe(200);
    // One counter for the three endpoints: the 60th is a creation.
    expect((await create('person@example.com')).status).toBe(201);

    const refused = await create('late@example.com');
    const message = await expectError(refused, 429, 'rate_limited');
    const seconds = Number(refused.headers.get('retry-after'));
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(message).toContain(`${seconds} second`);
    await expectError(await send(signed('GET', PATH)), 429, 'rate_limited');
    await expectError(await revoke('abc'), 429, 'rate_limited');
    expect(await db().admissionInvitation.count()).toBe(1);

    // NFR-SE-19: the limit reached, once for its period.
    expect((await logged('rate_limit_reached')).length).toBe(1);
  });

  it('is not spent by requests whose signature does not verify', async () => {
    for (let n = 0; n < 100; n++) {
      expect((await send(signed('GET', PATH, undefined, {}))).status).toBe(401);
    }
    for (let n = 0; n < 60; n++) expect((await send(signed('GET', PATH))).status).toBe(200);
  });

  it('rejects a request whose signature does not verify whatever the count', async () => {
    for (let n = 0; n < 60; n++) await send(signed('GET', PATH));
    expect((await send(signed('GET', PATH))).status).toBe(429);
    // Not a 429: nothing is told to a caller without the secret.
    await expectError(await send(signed('GET', PATH, undefined, {})), 401, 'unauthorised');
  });

  it('fails closed: a verified request is refused, and nothing is created, where the limiter cannot answer (NFR-SE-06, A10)', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(valkey(), 'eval').mockRejectedValue(new Error('ECONNREFUSED redis://secret@host'));
    await expectError(await create('person@example.com'), 500, 'internal');
    await expectError(await send(signed('GET', PATH)), 500, 'internal');
    await afterResponse();
    expect(await db().admissionInvitation.count()).toBe(0);
    expect(mail()).toEqual([]);
    expect(printed.mock.calls).toEqual([
      ['admission: request failed (Error)'],
      ['admission: request failed (Error)'],
    ]);
  });
});

describe('the command (FR-AU-89; register D113)', () => {
  const ENV = { ADMISSION_SECRET: SECRET, APP_ORIGIN: ORIGIN };
  /** `fetch`, answered by the route handlers: nothing is started. */
  const viaHandlers = ((input: string | URL | Request, init?: RequestInit) =>
    send(new Request(input, init))) as typeof fetch;

  async function command(args: string[], env: Record<string, string | undefined> = ENV) {
    const lines: string[] = [];
    const code = await run(args, env, viaHandlers, (line) => lines.push(line));
    return { code, output: lines.join('\n') };
  }

  it('creates, lists, and revokes through the endpoints, and prints the answers', async () => {
    const created = await command(['create', 'Person@example.com']);
    expect(created.code).toBe(0);
    expect(created.output).toMatch(/^201\n/);
    const invitation = JSON.parse(created.output.slice(4));
    expect(invitation).toMatchObject({ email: 'person@example.com', state: 'pending' });

    const listed = await command(['list']);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.output.slice(4)).invitations).toEqual([invitation]);

    const revoked = await command(['revoke', invitation.id]);
    expect(revoked.code).toBe(0);
    expect(JSON.parse(revoked.output.slice(4))).toEqual({ ...invitation, state: 'revoked' });
    expect(await db().admissionInvitation.count()).toBe(1);
  });

  it('prints neither the token nor the link', async () => {
    const outputs = [await command(['create', 'person@example.com']), await command(['list'])];
    await afterResponse();
    const token = tokenIn(mail()[0]);
    for (const { output } of outputs) {
      expect(output).not.toContain(token);
      expect(output).not.toContain(hashOf(token));
      expect(output).not.toContain('sign-up');
    }
  });

  it('issues a new request identifier for each invitation it intends', async () => {
    await command(['create', 'person@example.com']);
    await command(['create', 'person@example.com']);
    const rows = await db().admissionInvitation.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => row.state)).toEqual(['REVOKED', 'PENDING']);
    expect(new Set(rows.map((row) => row.requestId)).size).toBe(2);
    for (const row of rows) expect(row.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('prints a refusal and exits with 1', async () => {
    await createAccount(auth, 'member2@example.com');
    const exists = await command(['create', 'member2@example.com']);
    expect(exists.code).toBe(1);
    expect(exists.output).toMatch(/^409\n/);
    expect(exists.output).toContain('account_exists');

    const wrongSecret = await command(['list'], { ...ENV, ADMISSION_SECRET: `${SECRET}x` });
    expect(wrongSecret.code).toBe(1);
    expect(wrongSecret.output).toMatch(/^401\n/);
    expect(wrongSecret.output).not.toContain(SECRET);
  });

  it('sends nothing without its two settings, over plain HTTP, or for an unknown action', async () => {
    const sent = vi.fn();
    const attempt = (args: string[], env: Record<string, string | undefined>) =>
      run(args, env, sent as unknown as typeof fetch, () => {});
    expect(await attempt(['list'], { APP_ORIGIN: ORIGIN })).toBe(2);
    expect(await attempt(['list'], { ADMISSION_SECRET: SECRET })).toBe(2);
    expect(await attempt(['list'], { ...ENV, APP_ORIGIN: 'http://app.example.test' })).toBe(2);
    expect(await attempt([], ENV)).toBe(2);
    expect(await attempt(['create'], ENV)).toBe(2);
    expect(await attempt(['delete', 'abc'], ENV)).toBe(2);
    expect(await attempt(['list', 'extra'], ENV)).toBe(2);
    expect(sent).not.toHaveBeenCalled();
  });

  it('refuses to revoke an identifier that no invitation could have, before anything is signed', async () => {
    const sent = vi.fn();
    for (const id of ['', 'a/b', '../invitations', 'a?b', 'a b', 'ä', 'x'.repeat(65)]) {
      const lines: string[] = [];
      const code = await run(['revoke', id], ENV, sent as unknown as typeof fetch, (line) =>
        lines.push(line),
      );
      expect(code, id).toBe(2);
      expect(lines.join('\n')).toMatch(/^Usage:/);
    }
    expect(sent).not.toHaveBeenCalled();
    // The longest an identifier can be is sent.
    expect((await command(['revoke', 'x'.repeat(64)])).output).toMatch(/^404\n/);
  });

  it('prints one line and exits with 1 for an origin that cannot be read, and sends nothing', async () => {
    const sent = vi.fn();
    const lines: string[] = [];
    const env = { ...ENV, APP_ORIGIN: 'app.example.test' };
    expect(await run(['list'], env, sent as unknown as typeof fetch, (line) => lines.push(line))).toBe(1);
    expect(lines).toEqual([
      'APP_ORIGIN must be an origin: a scheme, a host and an optional port, with nothing after.',
    ]);
    expect(sent).not.toHaveBeenCalled();
  });

  it('prints one line and exits with 1 where the answer cannot be read', async () => {
    const broken = (async () => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error(`terminated: ${SECRET}`)),
    })) as unknown as typeof fetch;
    const lines: string[] = [];
    expect(await run(['list'], ENV, broken, (line) => lines.push(line))).toBe(1);
    expect(lines).toEqual([
      'The command could not read the answer of the application. List the invitations to see what was done.',
    ]);
  });

  it('is a client and nothing more: it imports the signature module and the platform alone', () => {
    const source = readFileSync('scripts/admission.ts', 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['../src/lib/admission/signature.ts', 'node:crypto']);
    expect(source).not.toMatch(/\bimport\(/);
    const signature = readFileSync('src/lib/admission/signature.ts', 'utf8');
    expect([...signature.matchAll(/from '([^']+)'/g)].map((match) => match[1])).toEqual(['node:crypto']);
  });
});

describe('what no log holds (NFR-SE-19)', () => {
  it('neither an address, nor a token, nor the secret, through every answer of the endpoints', async () => {
    const outputs = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => {}),
    );
    const { id } = await (await create('private.person@example.com')).json();
    await create('private.person@example.com');
    await send(signed('GET', PATH));
    await revoke(id);
    await revoke('no-such-invitation');
    await send(signed('POST', PATH, { email: 'not an address', requestId: 'r' }));
    await send(signed('POST', PATH, { email: 'private.person@example.com', requestId: 'r' }, {}));
    await afterResponse();
    const tokens = mail().map(tokenIn);
    expect(tokens.length).toBe(2);

    const printed = JSON.stringify(outputs.flatMap((output) => output.mock.calls));
    for (const secret of ['private.person', 'example.com', SECRET, ...tokens, ...tokens.map(hashOf)]) {
      expect(printed).not.toContain(secret);
    }
    const stored = database.sql(
      "SELECT coalesce(string_agg(row_to_json(e)::text, ' '), '') FROM \"SecurityLogEntry\" e",
    );
    for (const secret of ['private.person', 'example.com', ...tokens]) expect(stored).not.toContain(secret);
  });

  it('answers a fault with a 500 that says nothing of it, and logs its class alone', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db().admissionInvitation, 'findMany').mockRejectedValue(
      Object.assign(new Error('relation holds private.person@example.com'), { code: 'P1001' }),
    );
    const response = await send(signed('GET', PATH));
    const message = await expectError(response, 500, 'internal');
    expect(message).not.toContain('private.person');
    // Its class and its code, which tells one fault from another, and nothing it said.
    expect(JSON.stringify(printed.mock.calls)).toBe('[["admission: request failed (Error P1001)"]]');
  });
});
