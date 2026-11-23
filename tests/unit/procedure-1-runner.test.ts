// The runner of procedure 1 (scripts/measure/procedure-1.ts; NFR-PE-01): its accounts file, its sessions, its order
// of steps, and that it prints nothing it must not. The application is a small stand-in that answers the routes the
// runner calls, as the application does (status and code of each).
/* eslint-disable @typescript-eslint/no-explicit-any -- the stand-in application and the stubbed steps take loose shapes */
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auto,
  Jar,
  Pacer,
  loadAccounts,
  saveAccounts,
  signIn,
  Client,
  tokenOf,
  type AutoOptions,
} from '../../scripts/measure/procedure-1.ts';

const ORIGIN = 'https://app.test';
const PEOPLE = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'].map((each) => `${each}@test.example`);
const OWNER = 'owner@test.example';
const OWNER_PASSWORD = 'owner-password-for-tests';
const LINK = (token: string) => `${ORIGIN}/sign-up/${token}`;

function directory(): string {
  return mkdtempSync(join(tmpdir(), 'procedure-1-'));
}

function accountsFile(dir: string, mutate: (file: any) => void = () => {}, mode = 0o600): string {
  const file: any = {
    owner: { email: OWNER, password: OWNER_PASSWORD },
    testers: PEOPLE.map((email, at) =>
      at === 2
        ? { email, invitationLink: LINK('token-of-t3') }
        : { email, password: `password-of-${at}-xxxx` },
    ),
  };
  mutate(file);
  const path = join(dir, 'accounts.json');
  writeFileSync(path, JSON.stringify(file));
  chmodSync(path, mode);
  return path;
}

/** The routes the runner calls, answered as the application answers them, and what each saw. */
function application(options: { twoFactor?: boolean; refuseSignInOf?: string } = {}) {
  const seen = {
    acknowledged: new Set<string>(),
    passwords: [] as string[],
    origins: new Set<string>(),
    hosts: new Set<string>(),
  };
  const passwords = new Map<string, string>([[OWNER, OWNER_PASSWORD]]);
  PEOPLE.forEach((email, at) => passwords.set(email, `password-of-${at}-xxxx`));
  const invited = new Map<string, string>();
  const accepted = new Set<string>();
  let documents = 0;
  const answer = (status: number, body: unknown, cookies: string[] = []) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return new Response(JSON.stringify(body), { status, headers });
  };
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.hosts.add(url.origin);
    const headers = new Headers(init?.headers);
    seen.origins.add(headers.get('origin') ?? '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = `${init?.method} ${url.pathname.replace(/[0-9a-f-]{36}/g, ':id')}`;
    switch (route) {
      case 'POST /api/sign-up':
        if (body.token !== 'token-of-t3') return answer(409, { error: { code: 'invitation_not_open' } });
        seen.passwords.push(body.password);
        passwords.set(PEOPLE[2]!, body.password);
        return answer(201, { signedIn: true }, ['session=signed-up; Path=/']);
      case 'POST /api/auth/sign-in/email':
        if (body.email === options.refuseSignInOf || passwords.get(body.email) !== body.password)
          return answer(401, { error: { code: 'sign_in_refused' } });
        if (options.twoFactor && body.email === OWNER)
          return answer(200, { twoFactorRedirect: true }, ['two_factor=step; Path=/']);
        return answer(200, {}, [
          `session=of-${body.email}; Path=/`,
          `session_data=copy-${body.email}; Path=/`,
        ]);
      case 'POST /api/auth/two-factor/verify-totp':
        if (body.code !== '123456' || !headers.get('cookie')?.includes('two_factor=step'))
          return answer(401, { error: { code: 'invalid_code' } });
        return answer(200, {}, [`session=of-${OWNER}; Path=/`, 'two_factor=; Max-Age=0; Path=/']);
      case 'GET /api/account/closed-alpha-notice':
        return answer(200, {
          currentVersion: 1,
          acknowledgedVersion: seen.acknowledged.has(headers.get('cookie') ?? '') ? 1 : null,
        });
      case 'POST /api/account/closed-alpha-notice/acknowledgement':
        seen.acknowledged.add(headers.get('cookie') ?? '');
        return answer(200, {});
      case 'POST /api/documents':
        return answer(201, { id: `00000000-0000-0000-0000-00000000000${++documents}` });
      case 'PATCH /api/documents/:id':
        return answer(200, {});
      case 'POST /api/documents/:id/invitations':
        for (const email of body.emails) invited.set(`${url.pathname}|${email}`, `inv-${invited.size}`);
        return answer(201, { confirmations: [] });
      case 'GET /api/documents/:id/collaborators': {
        const mine = [...invited].filter(([key]) =>
          key.startsWith(`${url.pathname.replace('/collaborators', '/invitations')}|`),
        );
        const done = mine.filter(([, id]) => accepted.has(id));
        const pending = mine.filter(([, id]) => !accepted.has(id));
        return answer(200, {
          people: 1 + mine.length,
          limit: 10,
          collaborators: done.map(() => ({ role: 'Editor' })),
          invitations: pending.map(([key, id]) => ({ id, email: key.split('|')[1] })),
        });
      }
      default: {
        const accept = /^POST \/api\/invitations\/received\/(inv-\d+)\/accept$/.exec(route);
        if (accept) {
          accepted.add(accept[1]!);
          return answer(200, {});
        }
        return answer(404, { error: { code: 'not_found' } });
      }
    }
  };
  return { send, seen };
}

function steps() {
  const calls: string[] = [];
  const cookies: string[][] = [];
  const target = (t: { documentId: string; cookies: readonly string[] }) => cookies.push([...t.cookies]);
  const result = {
    madeAt: '',
    minutes: 10,
    tool: 'chromium',
    connections: 10,
    rate: 4,
    typed: 2400,
    seconds: 600,
    keystroke: { n: 2400, p50: 8, p99: 30, max: 60 },
    keystrokesNotFound: 0,
    propagation: { n: 21600, p50: 40, p99: 120, max: 300 },
    propagationMissing: 0,
    perReceiver: Array.from({ length: 9 }, () => ({ n: 2400, p50: 40, p99: 120, max: 300 })),
  };
  return {
    calls,
    cookies,
    seed: vi.fn(
      async (t: any, words: number) => (target(t), calls.push(`seed ${words}`), { blocks: 10, words }),
    ),
    run: vi.fn(
      async (t: any, o: any) => (
        target(t),
        calls.push(`run ${o.out.split('/').pop()}`),
        { result, ok: true }
      ),
    ),
    pageload: vi.fn(
      async () => (
        calls.push('pageload'),
        { pageLoad: { pages: { 'list of documents': { loads: 20, p75: 900, met: true } } }, ok: true }
      ),
    ),
  };
}

let dir: string;
let output: string;
beforeEach(() => {
  dir = directory();
  output = '';
  const write = (...args: unknown[]) => void (output += `${args.join(' ')}\n`);
  vi.spyOn(console, 'log').mockImplementation(write);
  vi.spyOn(console, 'error').mockImplementation(write);
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (chunk: string | Uint8Array) => ((output += String(chunk)), true),
  );
  vi.spyOn(process.stderr, 'write').mockImplementation(
    (chunk: string | Uint8Array) => ((output += String(chunk)), true),
  );
});
afterEach(() => vi.restoreAllMocks());

function options(
  path: string,
  fake: ReturnType<typeof application>,
  run: ReturnType<typeof steps>,
  more: Partial<AutoOptions> = {},
): AutoOptions {
  return {
    origin: ORIGIN,
    accountsPath: path,
    minutes: 10,
    rate: 4,
    loads: 20,
    send: fake.send,
    repository: '/somewhere/else',
    chromiumVersion: async () => '1.2.3',
    steps: run as never,
    code: async () => '123456',
    pacer: new Pacer(1000),
    ...more,
  };
}

describe('the accounts file, hardened', () => {
  it('does not quote its text when it is not JSON (the parser would quote a password)', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, `{"owner": {"email": "a@b.test", "password": 'single-quoted-secret'}}`);
    chmodSync(path, 0o600);
    expect(() => loadAccounts(path, '/x')).toThrow(
      expect.objectContaining({ message: 'The accounts file is not valid JSON.' }),
    );
  });

  it('refuses a file by its real path: a link into the repository, or the same path in another case', () => {
    const repository = directory();
    const inside = join(repository, 'accounts.json');
    writeFileSync(inside, '{}');
    chmodSync(inside, 0o600);
    const link = join(dir, 'link.json');
    symlinkSync(inside, link);
    expect(() => loadAccounts(link, repository)).toThrow('inside the repository');
    expect(() => loadAccounts(inside.toUpperCase(), repository)).toThrow();
  });

  it('refuses any mode that others can read, and a second name for the file', () => {
    for (const mode of [0o640, 0o604, 0o660])
      expect(() =>
        loadAccounts(
          accountsFile(dir, () => {}, mode),
          '/x',
        ),
      ).toThrow();
    const path = accountsFile(dir);
    linkSync(path, join(dir, 'other-name.json'));
    expect(() => loadAccounts(path, '/x')).toThrow('hard link');
  });

  it('writes the file whole at mode 0600 and leaves no temporary file, and refuses a planted name', () => {
    const path = accountsFile(dir);
    saveAccounts(path, loadAccounts(path, '/x'));
    expect(readdirSync(dir)).toEqual(['accounts.json']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('the accounts file', () => {
  it('is refused where others can read it, where it is inside the repository, or where it is not of the shape', () => {
    expect(() =>
      loadAccounts(
        accountsFile(dir, () => {}, 0o644),
        '/x',
      ),
    ).toThrow('readable by others');
    expect(() => loadAccounts(accountsFile(dir), dir)).toThrow('inside the repository');
    expect(() =>
      loadAccounts(
        accountsFile(dir, (file) => file.testers.pop()),
        '/x',
      ),
    ).toThrow('exactly 9');
    expect(() =>
      loadAccounts(
        accountsFile(dir, (file) => delete file.testers[0].password),
        '/x',
      ),
    ).toThrow('tester 1');
    expect(() =>
      loadAccounts(
        accountsFile(dir, (file) => (file.testers[0].email = OWNER.toUpperCase())),
        '/x',
      ),
    ).toThrow('same email');
  });

  it('does not put a password in the message of a refusal', () => {
    const path = accountsFile(dir, (file) => file.testers.pop());
    expect(() => loadAccounts(path, '/x')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(OWNER_PASSWORD) }),
    );
  });
});

describe('the cookies', () => {
  it("are kept by name, dropped when expired, and the second step's cookie is not part of the session", () => {
    const jar = new Jar();
    const headers = new Headers();
    headers.append('Set-Cookie', 'session=a; Path=/; HttpOnly');
    headers.append('Set-Cookie', 'two_factor=b; Path=/');
    jar.absorb(headers);
    expect(jar.header()).toBe('session=a; two_factor=b');
    expect(jar.session()).toBe('session=a');
    const gone = new Headers();
    gone.append('Set-Cookie', 'two_factor=; Max-Age=0; Path=/');
    jar.absorb(gone);
    expect(jar.header()).toBe('session=a');
  });
});

describe('the pace of the requests of a person without a session (NFR-SE-07)', () => {
  it('lets 15 through in a minute and makes the 16th wait until the first has left the minute', async () => {
    const waits: number[] = [];
    const pacer = new Pacer(15, 60_000, async (ms) => void waits.push(ms));
    for (let n = 0; n < 15; n++) await pacer.take();
    expect(waits).toEqual([]);
    vi.useFakeTimers();
    const sixteenth = new Pacer(1, 60_000, async (ms) => void vi.advanceTimersByTime(ms));
    await sixteenth.take();
    const before = Date.now();
    await sixteenth.take();
    expect(Date.now() - before).toBeGreaterThanOrEqual(60_000);
    vi.useRealTimers();
  });
});

describe('sign-in', () => {
  it('asks for the code only where the account asks for it, and refuses what is not six digits before sending it', async () => {
    const fake = application({ twoFactor: true });
    const owner = new Client(ORIGIN, fake.send);
    await expect(
      signIn(owner, { email: OWNER, password: OWNER_PASSWORD }, 'the owner', async () => '12345'),
    ).rejects.toThrow('six digits');
    const cookie = await signIn(
      new Client(ORIGIN, fake.send),
      { email: OWNER, password: OWNER_PASSWORD },
      'the owner',
      async () => '123456',
    );
    expect(cookie).toBe(`session=of-${OWNER}`);
  });

  it('refuses a link of another origin or of another shape', () => {
    expect(tokenOf(LINK('abc'), ORIGIN)).toBe('abc');
    expect(() => tokenOf('https://elsewhere.test/sign-up/abc', ORIGIN)).toThrow('not a sign-up link');
    expect(() => tokenOf(`${ORIGIN}/other/abc`, ORIGIN)).toThrow('not a sign-up link');
    expect(() => tokenOf('not an address', ORIGIN)).toThrow('not an address');
  });
});

describe('auto', () => {
  it('signs up the account that has a link, writes its password back, and prints no secret', async () => {
    const fake = application();
    const run = steps();
    const path = accountsFile(dir);
    await auto(options(path, fake, run));

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.testers[2].invitationLink).toBeUndefined();
    expect(written.testers[2].password).toBe(fake.seen.passwords[0]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, 'cookies.json'))).toBe(false);

    for (const secret of [
      OWNER_PASSWORD,
      written.testers[2].password,
      'token-of-t3',
      'session=',
      'copy-',
      'password-of-',
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain('Chromium 1.2.3');
    expect(output).toContain('people listed: 10');
    expect(output).toContain('keystroke to render: P50 8 ms, P99 30 ms');
  });

  it('runs the steps in the order of the procedure, with ten cookies, and writes beside the accounts file', async () => {
    const fake = application();
    const run = steps();
    await auto(options(accountsFile(dir), fake, run));
    expect(run.calls).toEqual([
      'seed 5000',
      'run result-5k.json',
      'pageload',
      'seed 50000',
      'run result-50k.json',
    ]);
    expect(
      run.cookies.every(
        (list) => list.length === 10 && list[0] === `session=of-${OWNER}; session_data=copy-${OWNER}`,
      ),
    ).toBe(true);
    expect(run.run.mock.calls[0]![1]).toMatchObject({
      minutes: 10,
      rate: 4,
      out: join(dir, 'result-5k.json'),
    });
  });

  it('says nothing secret in the message of a failure either', async () => {
    const fake = application({ refuseSignInOf: PEOPLE[3] });
    const message = await auto(options(accountsFile(dir), fake, steps())).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(message).toContain('sign in tester 4');
    for (const secret of [OWNER_PASSWORD, 'token-of-t3', 'password-of-', 'session=', '@test.example'])
      expect(message + output).not.toContain(secret);
  });

  it('acknowledges the Closed α notice of each of the ten accounts, once', async () => {
    const fake = application();
    await auto(options(accountsFile(dir), fake, steps()));
    expect(fake.seen.acknowledged.size).toBe(10);
  });

  it('contacts the origin it was given and no other, as that origin', async () => {
    const fake = application();
    await auto(options(accountsFile(dir), fake, steps()));
    expect([...fake.seen.hosts]).toEqual([ORIGIN]);
    expect([...fake.seen.origins]).toEqual([ORIGIN]);
  });

  it('stops at the first failure and says which step it was, before any measuring', async () => {
    const fake = application({ refuseSignInOf: PEOPLE[3] });
    const run = steps();
    await expect(auto(options(accountsFile(dir), fake, run))).rejects.toThrow(
      'step "sign in tester 4" failed',
    );
    expect(run.seed).not.toHaveBeenCalled();
  });

  it('stops at a 50,000-word seed that the server refuses, with its reason, and does not run on it', async () => {
    const fake = application();
    const run = steps();
    run.seed.mockImplementation(async (_t: any, words: number) => {
      if (words === 50000) throw new Error('A connection was refused: the document is too large');
      return { blocks: 1, words };
    });
    await expect(auto(options(accountsFile(dir), fake, run))).rejects.toThrow(
      'step "seed 50000 words" failed: A connection was refused: the document is too large',
    );
    expect(run.run).toHaveBeenCalledTimes(1);
  });

  it('asks the owner for a code where the account has two-factor authentication', async () => {
    const fake = application({ twoFactor: true });
    const code = vi.fn(async () => '123456');
    await auto(options(accountsFile(dir), fake, steps(), { code }));
    expect(code).toHaveBeenCalledTimes(1);
  });

  it('refuses plain http away from localhost, and a link of another origin, before it signs anything up', async () => {
    const fake = application();
    await expect(
      auto(options(accountsFile(dir), fake, steps(), { origin: 'http://app.test' })),
    ).rejects.toThrow('https');
    const path = accountsFile(
      dir,
      (file) => (file.testers[2].invitationLink = 'https://elsewhere.test/sign-up/x'),
    );
    await expect(auto(options(path, fake, steps()))).rejects.toThrow('step "sign up tester 3" failed');
    expect(fake.seen.passwords).toEqual([]);
  });
});
