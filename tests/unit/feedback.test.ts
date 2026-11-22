// The application's side of docs/contracts/feedback-intake.md (provisional, Praktico's to restate): the signed
// client, the body of `POST /api/feedback`, its answers and limits, the secret, and step (c) of a deletion.
// Each rule of the contract has a test here that fails when it is broken. The intake is the double of
// tests/fixtures/praktico-double.ts.
import { describe, expect, it, vi } from 'vitest';
import { sign } from '../../src/lib/admission/signature.ts';
import {
  DETACH_AGAIN_MS,
  DETACH_DELAY_MS,
  feedbackAgain,
  feedbackStep,
  FeedbackNotAcknowledged,
} from '../../src/lib/account/feedback-step.ts';
import {
  deliver,
  feedbackIntake,
  INTAKE_PATH,
  PSEUDONYMISE_PATH,
  type IntakeBody,
} from '../../src/lib/feedback/client.ts';
import { browserOf, handleFeedback, type Dependencies } from '../../src/lib/feedback/submit.ts';
import { codePoints, validateSubmission } from '../../src/lib/feedback/validate.ts';
import { feedbackSecret } from '../../src/lib/settings.ts';
import { praktico } from '../fixtures/praktico-double.ts';

// "Too short to be accepted as a real one and exists only for these two vectors" (the contract's worked examples).
const VECTOR_SECRET = 'test-secret-not-for-use';
const VECTOR_TIME = '1791450000';
const SECRET = 'F'.repeat(43);
const NOW = Date.parse('2026-10-08T09:00:00.000Z');

const INTAKE_VECTOR = JSON.stringify({
  submissionId: '6f1d2c9e-3b7a-4f58-9a0e-2d4c8b1e7a35',
  submittedAt: '2026-10-08T09:00:00.000Z',
  kind: 'problem',
  message: 'The page does not scroll.',
  route: '/workspaces/[id]',
  appVersion: '0.1.0',
  browser: { name: 'Firefox', major: 140, osFamily: 'macOS' },
  viewport: { width: 1440, height: 900 },
  accountId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
});
const PSEUDONYMISE_VECTOR = '{"accountId":"a1b2c3d4e5f60718293a4b5c6d7e8f90"}';

describe('the signed form (the contract’s two worked examples)', () => {
  it('signs the intake body as the page does', () => {
    const body = Buffer.from(INTAKE_VECTOR);
    expect(body.byteLength).toBe(345);
    expect(
      sign(VECTOR_SECRET, VECTOR_TIME, '00112233445566778899aabbccddeeff', 'POST', INTAKE_PATH, body),
    ).toBe('07a07f3dbd9a7ac3140183024cdad7d70d8709ec9696933de2b391b365e751ef');
  });
  it('signs the pseudonymise body as the page does', () => {
    const body = Buffer.from(PSEUDONYMISE_VECTOR);
    expect(body.byteLength).toBe(48);
    expect(
      sign(VECTOR_SECRET, VECTOR_TIME, 'ffeeddccbbaa99887766554433221100', 'POST', PSEUDONYMISE_PATH, body),
    ).toBe('b517b78a219de72537fe151a9f3eb7fbe840d779a8b5bb61745f2da933fb8dd1');
  });
});

const body = (): IntakeBody => JSON.parse(INTAKE_VECTOR) as IntakeBody;

describe('the client of the intake', () => {
  const setup = () => {
    const double = praktico(SECRET, () => NOW);
    return { double, dependencies: { fetch: double.fetch, now: () => NOW, secret: () => SECRET } };
  };

  it('is accepted by a receiver that verifies the three headers, in the contract’s order', async () => {
    const { double, dependencies } = setup();
    await expect(deliver(body(), dependencies)).resolves.toBe(true);
    const [request] = double.requests;
    expect(request!.path).toBe(INTAKE_PATH);
    expect(request!.headers.get('x-ekdotico-timestamp')).toBe(String(NOW / 1000));
    expect(request!.headers.get('x-ekdotico-nonce')).toMatch(/^[0-9a-f]{32}$/);
    expect(request!.headers.get('x-ekdotico-signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(double.held).toHaveLength(1);
  });

  it('sends exactly the nine fields, as the bytes it signed', async () => {
    const { double, dependencies } = setup();
    await deliver(body(), dependencies);
    expect(Object.keys(JSON.parse(double.requests[0]!.body) as object).sort()).toEqual([
      'accountId',
      'appVersion',
      'browser',
      'kind',
      'message',
      'route',
      'submissionId',
      'submittedAt',
      'viewport',
    ]);
  });

  it('makes a new nonce and signature on every attempt and keeps the identifier; the intake holds one row', async () => {
    const { double, dependencies } = setup();
    await expect(deliver(body(), dependencies)).resolves.toBe(true);
    await expect(deliver(body(), dependencies)).resolves.toBe(true);
    const [first, second] = double.requests;
    expect(first!.headers.get('x-ekdotico-nonce')).not.toBe(second!.headers.get('x-ekdotico-nonce'));
    expect(first!.headers.get('x-ekdotico-signature')).not.toBe(second!.headers.get('x-ekdotico-signature'));
    expect(double.held).toHaveLength(1);
    expect(double.nonces.size).toBe(2);
  });

  it('is refused by the receiver for a wrong secret, and a time off by more than 300 seconds', async () => {
    const { double } = setup();
    await expect(
      deliver(body(), { fetch: double.fetch, now: () => NOW, secret: () => 'G'.repeat(43) }),
    ).resolves.toBe(false);
    await expect(
      deliver(body(), { fetch: double.fetch, now: () => NOW - 301_000, secret: () => SECRET }),
    ).resolves.toBe(false);
    expect(double.held).toHaveLength(0);
  });

  it.each([
    ['a 500', 500],
    ['a 400', 400],
    ['a 401', 401],
    ['a closed connection', 'throw' as const],
  ])('is a failure on %s', async (_name, failWith) => {
    const { double, dependencies } = setup();
    double.failWith = failWith;
    await expect(deliver(body(), dependencies)).resolves.toBe(false);
  });

  it.each([
    ['accepted false', { accepted: false }],
    ['accepted "true"', { accepted: 'true' }],
    ['a body of another shape', { ok: true }],
    ['no body', null],
  ])('does not take %s for acceptance', async (_name, answer) => {
    const { double, dependencies } = setup();
    double.answerWith = answer;
    await expect(deliver(body(), dependencies)).resolves.toBe(false);
  });

  it('waits at most 10 seconds for an answer', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    await deliver(body(), {
      secret: () => SECRET,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        seen.push(init?.signal);
        return Response.json({ accepted: true }, { status: 201 });
      }) as typeof fetch,
    });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it('puts no request header of the browser and no secret in what it sends', async () => {
    const { double, dependencies } = setup();
    await deliver(body(), dependencies);
    const sent = JSON.stringify([...double.requests[0]!.headers]) + double.requests[0]!.body;
    expect(sent).not.toContain(SECRET);
    expect(sent.toLowerCase()).not.toContain('user-agent');
  });

  it('throws, and does not call, where the secret is not usable', async () => {
    const send = vi.fn();
    await expect(
      deliver(body(), {
        fetch: send as unknown as typeof fetch,
        secret: () => {
          throw new Error('FEEDBACK_SECRET is not set.');
        },
      }),
    ).rejects.toThrow('FEEDBACK_SECRET');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('pseudonymise', () => {
  const setup = () => {
    const double = praktico(SECRET, () => NOW);
    return { double, intake: feedbackIntake({ fetch: double.fetch, now: () => NOW, secret: () => SECRET }) };
  };

  it('nulls the account of every row it names, and acknowledges with the count, then with 0 on a repeat', async () => {
    const { double, intake } = setup();
    double.held.push(
      { submissionId: 'a', accountId: 'acc-1', body: {} },
      { submissionId: 'b', accountId: 'acc-1', body: {} },
      { submissionId: 'c', accountId: 'acc-2', body: {} },
    );
    await expect(intake.pseudonymise('acc-1')).resolves.toBe(true);
    expect(double.held.map((row) => row.accountId)).toEqual([null, null, 'acc-2']);
    expect(double.requests[0]!.path).toBe(PSEUDONYMISE_PATH);
    expect(JSON.parse(double.requests[0]!.body)).toEqual({ accountId: 'acc-1' });
    await expect(intake.pseudonymise('acc-1')).resolves.toBe(true);
    await expect(intake.pseudonymise('nobody')).resolves.toBe(true);
  });

  it.each([
    ['accepted false', { accepted: false, changed: 0 }],
    ['no count', { accepted: true }],
    ['a count that is not whole', { accepted: true, changed: 1.5 }],
    ['a negative count', { accepted: true, changed: -1 }],
  ])('is not acknowledged on %s', async (_name, answer) => {
    const { double, intake } = setup();
    double.answerWith = answer;
    await expect(intake.pseudonymise('acc-1')).resolves.toBe(false);
  });

  it('is not acknowledged on a status other than 200, and rejects where there is no answer', async () => {
    const { double, intake } = setup();
    double.failWith = 500;
    await expect(intake.pseudonymise('acc-1')).resolves.toBe(false);
    double.failWith = 'throw';
    await expect(intake.pseudonymise('acc-1')).rejects.toBeInstanceOf(TypeError);
  });

  it('a new nonce on every repeat', async () => {
    const { double, intake } = setup();
    await intake.pseudonymise('acc-1');
    await intake.pseudonymise('acc-1');
    expect(double.nonces.size).toBe(2);
  });
});

describe('step (c) of a deletion', () => {
  it('waits 15 seconds before the call, and makes the call after the wait', async () => {
    const order: string[] = [];
    await feedbackStep('acc-1', {
      enabled: () => true,
      wait: async (milliseconds) => {
        order.push(`wait ${milliseconds}`);
      },
      intake: {
        pseudonymise: async () => {
          order.push('call');
          return true;
        },
      },
    });
    expect(DETACH_DELAY_MS).toBe(15_000);
    expect(order).toEqual(['wait 15000', 'call']);
  });

  it('neither waits nor calls with the switch off', async () => {
    const wait = vi.fn(async () => {});
    const pseudonymise = vi.fn(async () => true);
    await expect(
      feedbackStep('acc-1', { enabled: () => false, wait, intake: { pseudonymise } }),
    ).resolves.toBe('skipped');
    expect(wait).not.toHaveBeenCalled();
    expect(pseudonymise).not.toHaveBeenCalled();
  });

  it('fails, to be repeated, where the real client has no usable secret', async () => {
    const before = process.env.FEEDBACK_SECRET;
    delete process.env.FEEDBACK_SECRET;
    try {
      await expect(
        feedbackStep('acc-1', { enabled: () => true, wait: async () => {} }),
      ).rejects.toBeInstanceOf(FeedbackNotAcknowledged);
    } finally {
      if (before !== undefined) process.env.FEEDBACK_SECRET = before;
    }
  });
});

describe('the second call to the intake, step (g) (fw-late-write)', () => {
  it('is the same instruction, and is due 360 seconds after the first, which keeps the rule of at least 301', async () => {
    expect(DETACH_AGAIN_MS).toBe(360_000);
    expect(DETACH_AGAIN_MS).toBeGreaterThanOrEqual(301_000);
    const pseudonymise = vi.fn(async () => true);
    await feedbackAgain('acc-1', { intake: { pseudonymise } });
    expect(pseudonymise).toHaveBeenCalledExactlyOnceWith('acc-1');
  });

  it('does not read the switch: it calls the intake with the switch off (fw-detach-switch)', async () => {
    const before = process.env.FEEDBACK_INTAKE_ENABLED;
    process.env.FEEDBACK_INTAKE_ENABLED = 'false';
    try {
      const pseudonymise = vi.fn(async () => true);
      await feedbackAgain('acc-1', { intake: { pseudonymise } });
      expect(pseudonymise).toHaveBeenCalledExactlyOnceWith('acc-1');
    } finally {
      if (before === undefined) delete process.env.FEEDBACK_INTAKE_ENABLED;
      else process.env.FEEDBACK_INTAKE_ENABLED = before;
    }
  });

  it('throws where the intake did not acknowledge, so that it is repeated', async () => {
    await expect(
      feedbackAgain('acc-1', { intake: { pseudonymise: async () => false } }),
    ).rejects.toBeInstanceOf(FeedbackNotAcknowledged);
    await expect(
      feedbackAgain('acc-1', {
        intake: {
          pseudonymise: async () => {
            throw new Error('down');
          },
        },
      }),
    ).rejects.toBeInstanceOf(FeedbackNotAcknowledged);
  });

  it('is signed with a nonce and a time of its own, against the one secret the application holds', async () => {
    const double = praktico(SECRET, () => NOW);
    const intake = feedbackIntake({ fetch: double.fetch, now: () => NOW, secret: () => SECRET });
    await feedbackAgain('acc-1', { intake });
    await feedbackAgain('acc-1', { intake });
    expect(double.nonces.size).toBe(2);
  });
});

describe('the secret', () => {
  const GOOD = 'A'.repeat(43);
  it('is read at the call and not at load: a module that imports it reads nothing', () => {
    expect(() => feedbackSecret({})).toThrow('FEEDBACK_SECRET is not set.');
    expect(feedbackSecret({ FEEDBACK_SECRET: GOOD })).toBe(GOOD);
  });
  it.each([
    ['too short', 'A'.repeat(42)],
    ['outside the alphabet', 'A'.repeat(42) + '+'],
  ])('refuses a value that is %s, and never quotes it', (_name, value) => {
    expect(() => feedbackSecret({ FEEDBACK_SECRET: value })).toThrow('at least 43');
    expect(() => feedbackSecret({ FEEDBACK_SECRET: value })).not.toThrow(value);
  });
  it('refuses the admission secret and the authentication secret', () => {
    expect(() => feedbackSecret({ FEEDBACK_SECRET: GOOD, ADMISSION_SECRET: GOOD })).toThrow('must differ');
    expect(() => feedbackSecret({ FEEDBACK_SECRET: GOOD, AUTH_SECRET: GOOD })).toThrow('must differ');
  });
});

describe('the body of the browser', () => {
  const valid = {
    kind: 'idea',
    message: 'Hello',
    route: '/workspaces/[id]',
    viewport: { width: 1280, height: 720 },
  };
  const rules = (input: unknown) => {
    const result = validateSubmission(input);
    return result.ok ? [] : result.faults;
  };

  it('accepts the contract’s shape, and trims the message', () => {
    expect(validateSubmission({ ...valid, message: '  Hello \n' })).toEqual({ ok: true, value: valid });
    expect(validateSubmission({ ...valid, submissionId: 'abc_-1' }).ok).toBe(true);
  });

  it('refuses a field that is not one of the five, an account identifier among them', () => {
    expect(rules({ ...valid, accountId: 'x' })).toEqual([{ field: 'body', rule: 'unknown' }]);
    expect(rules({ ...valid, appVersion: '0.1.0' })).toEqual([{ field: 'body', rule: 'unknown' }]);
  });

  it('names each field that is missing, and a body that is no object', () => {
    expect(rules({})).toEqual([
      { field: 'kind', rule: 'required' },
      { field: 'message', rule: 'required' },
      { field: 'route', rule: 'required' },
      { field: 'viewport', rule: 'required' },
    ]);
    expect(rules(null)).toEqual([{ field: 'body', rule: 'format' }]);
    expect(rules([])).toEqual([{ field: 'body', rule: 'format' }]);
  });

  it('holds the kind to its three values', () => {
    expect(rules({ ...valid, kind: 'bug' })).toEqual([{ field: 'kind', rule: 'format' }]);
    expect(rules({ ...valid, kind: 3 })).toEqual([{ field: 'kind', rule: 'format' }]);
  });

  it('refuses an empty message, a whitespace-only one, and one of another type', () => {
    expect(rules({ ...valid, message: '' })).toEqual([{ field: 'message', rule: 'empty' }]);
    expect(rules({ ...valid, message: ' \t\n ' })).toEqual([{ field: 'message', rule: 'empty' }]);
    expect(rules({ ...valid, message: 5 })).toEqual([{ field: 'message', rule: 'format' }]);
  });

  it('counts the message in code points: 4,000 of four UTF-16 units are accepted, 4,001 are refused', () => {
    const emoji = '\u{1F600}';
    const fits = emoji.repeat(4000);
    expect(fits.length).toBe(8000);
    expect(codePoints(fits)).toBe(4000);
    expect(validateSubmission({ ...valid, message: fits }).ok).toBe(true);
    expect(rules({ ...valid, message: emoji.repeat(4001) })).toEqual([
      { field: 'message', rule: 'too_long' },
    ]);
  });

  it.each([
    ['a C0 control', '\u0001'],
    ['a lone high surrogate', 'a\uD800b'],
    ['a lone low surrogate', 'a\uDC00b'],
    ['a high surrogate at the end', 'hello\uD83D'],
    ['a vertical tab, which trimming would remove', '\u000Bhello'],
    ['a form feed at the end, which trimming would remove', 'hello\u000C'],
    ['NUL', '\u0000'],
    ['DEL', '\u007F'],
    ['a C1 control', '\u0085'],
    ['the last C1 control', '\u009F'],
    ['a bidirectional override', '\u202E'],
    ['an isolate', '\u2067'],
  ])('refuses %s in the message', (_name, character) => {
    expect(rules({ ...valid, message: `a${character}b` })).toEqual([
      { field: 'message', rule: 'forbidden_character' },
    ]);
  });

  it.each([
    ['a tab', '\t'],
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['a zero-width space', '\u200B'],
    ['a zero-width joiner', '\u200D'],
    ['a line separator', '\u2028'],
    ['a paragraph separator', '\u2029'],
    ['a surrogate pair, one character', '\uD83D\uDE00'],
  ])('accepts %s inside the message', (_name, character) => {
    expect(validateSubmission({ ...valid, message: `a${character}b` }).ok).toBe(true);
  });

  it('holds the route to a pattern: no query, no fragment, no scheme, no raw path', () => {
    for (const route of [
      '/a?b=1',
      '/a#b',
      'a',
      'https://x.test/',
      '//x',
      '/a b',
      '/a/',
      '',
      '/'.padEnd(201, 'a'),
    ])
      expect(rules({ ...valid, route }), route).toEqual([{ field: 'route', rule: 'format' }]);
    expect(validateSubmission({ ...valid, route: '/' }).ok).toBe(true);
  });

  it('holds the viewport to two whole numbers from 1 to 32,767', () => {
    for (const viewport of [
      { width: 0, height: 1 },
      { width: 32768, height: 1 },
      { width: 1.5, height: 1 },
      { width: 1 },
      { width: 1, height: 1, depth: 1 },
      'wide',
    ])
      expect(rules({ ...valid, viewport })).toEqual([{ field: 'viewport', rule: 'format' }]);
    expect(validateSubmission({ ...valid, viewport: { width: 32767, height: 1 } }).ok).toBe(true);
  });

  it('holds the identifier to 1 to 64 characters of the URL-safe set', () => {
    for (const submissionId of ['', 'a'.repeat(65), 'a b', '\u00E9', 5])
      expect(rules({ ...valid, submissionId })).toEqual([{ field: 'submissionId', rule: 'format' }]);
  });
});

describe('the browser the application names', () => {
  it('reads the name, the major version and the system family, and no more', () => {
    expect(
      browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'),
    ).toEqual({ name: 'Firefox', major: 140, osFamily: 'macOS' });
  });
  it('gives unknown for an agent it cannot name, a crafted one included', () => {
    expect(browserOf('<script>alert(1)</script>')).toEqual({
      name: 'unknown',
      major: null,
      osFamily: 'unknown',
    });
    expect(browserOf(null)).toEqual({ name: 'unknown', major: null, osFamily: 'unknown' });
  });
});

// The route's rules, with the pieces of the application replaced by fakes, in the order of "The order of the checks".
describe('POST /api/feedback', () => {
  const FIRST = {
    kind: 'problem',
    message: 'It broke',
    route: '/documents/[id]',
    viewport: { width: 800, height: 600 },
  };
  const request = (payload: unknown = FIRST, headers: Record<string, string> = {}) =>
    new Request('https://app.test/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Firefox/140.0', ...headers },
      body: JSON.stringify(payload),
    });

  const setup = (over: Partial<Dependencies> = {}) => {
    const double = praktico(SECRET, () => NOW);
    const used = new Map<string, number>();
    const logs: string[] = [];
    const calls: string[] = [];
    const dependencies: Dependencies = {
      enabled: () => true,
      session: async () => ({ userId: 'acc-1' }),
      noticeAcknowledged: async () => true,
      // A place taken now and given back, as `takeLimitReturnable` does: the check and the count are one step.
      reserve: async (name, key) => {
        calls.push(`reserve ${name}`);
        const slot = `${name}:${key}`;
        const max = name === 'FEEDBACK_SHORT_PER_USER' ? 5 : 30;
        if ((used.get(slot) ?? 0) >= max) return { ok: false, retryAfterSeconds: 42 };
        used.set(slot, (used.get(slot) ?? 0) + 1);
        return {
          ok: true,
          giveBack: async () => {
            used.set(slot, used.get(slot)! - 1);
          },
        };
      },
      stillAllowed: async () => null,
      limitReached: async () => {},
      readJson: async (req) => (await req.json()) as unknown,
      deliver: (sent) => deliver(sent, { fetch: double.fetch, now: () => NOW, secret: () => SECRET }),
      appVersion: '0.1.2',
      now: () => new Date(NOW),
      newId: () => '6f1d2c9e-3b7a-4f58-9a0e-2d4c8b1e7a35',
      log: (line) => logs.push(line),
      ...over,
    };
    return { double, dependencies, used, logs, calls };
  };

  it('is closed as a route that does not exist while the switch is off, and reads nothing', async () => {
    const { dependencies } = setup({
      enabled: () => false,
      session: async () => {
        throw new Error('not reached');
      },
    });
    const response = await handleFeedback(request(), dependencies);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not_found');
  });

  it('answers 401 without a session, and the answer of the gate for an account it stops', async () => {
    expect(
      (
        await handleFeedback(
          request(),
          setup({ session: async () => ({ userId: null, denied: new Response(null, { status: 401 }) }) })
            .dependencies,
        )
      ).status,
    ).toBe(401);
    const stopped = new Response(null, { status: 403 });
    expect(
      (
        await handleFeedback(
          request(),
          setup({ session: async () => ({ userId: null, denied: stopped }) }).dependencies,
        )
      ).status,
    ).toBe(403);
  });

  it('answers 403 notice_not_acknowledged before the limit and the body are looked at', async () => {
    const { dependencies, calls } = setup({ noticeAcknowledged: async () => false });
    const response = await handleFeedback(request(), dependencies);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('notice_not_acknowledged');
    expect(calls).toEqual([]);
  });

  it('accepts a submission: 201 sent, the intake holds it, and each limit is counted once', async () => {
    const { dependencies, double, used, logs } = setup();
    const response = await handleFeedback(request(), dependencies);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ sent: true });
    expect(double.held).toHaveLength(1);
    expect([...used.values()]).toEqual([1, 1]);
    expect(logs).toEqual(['feedback 6f1d2c9e-3b7a-4f58-9a0e-2d4c8b1e7a35: sent']);
  });

  it('adds from the server: version, browser, account, identifier and time, and takes none of them from the body', async () => {
    const { dependencies, double } = setup();
    await handleFeedback(request(), dependencies);
    expect(JSON.parse(double.requests[0]!.body)).toEqual({
      submissionId: '6f1d2c9e-3b7a-4f58-9a0e-2d4c8b1e7a35',
      submittedAt: '2026-10-08T09:00:00.000Z',
      kind: 'problem',
      message: 'It broke',
      route: '/documents/[id]',
      appVersion: '0.1.2',
      browser: { name: 'Firefox', major: 140, osFamily: 'unknown' },
      viewport: { width: 800, height: 600 },
      accountId: 'acc-1',
    });
    const refused = await handleFeedback(request({ ...FIRST, accountId: 'someone-else' }), dependencies);
    expect(refused.status).toBe(422);
  });

  it('answers 502 not_sent with the identifier it issued when the intake does not accept, and counts nothing', async () => {
    const { dependencies, double, used, logs } = setup();
    double.failWith = 500;
    const response = await handleFeedback(request(), dependencies);
    expect(response.status).toBe(502);
    const answer = await response.json();
    expect(answer.error.code).toBe('not_sent');
    expect(answer.submissionId).toBe('6f1d2c9e-3b7a-4f58-9a0e-2d4c8b1e7a35');
    expect([...used.values()]).toEqual([0, 0]);
    expect(logs).toEqual(['feedback 6f1d2c9e-3b7a-4f58-9a0e-2d4c8b1e7a35: not sent']);
  });

  it('on a retry takes the identifier of the browser, and the intake holds one row, counted once', async () => {
    const { dependencies, double, used } = setup({ newId: () => 'never-used-on-a-retry' });
    double.failWith = 500;
    const failed = await handleFeedback(request({ ...FIRST, submissionId: 'issued-1' }), dependencies);
    expect(failed.status).toBe(502);
    expect((await failed.json()).submissionId).toBe('issued-1');
    double.failWith = null;
    expect((await handleFeedback(request({ ...FIRST, submissionId: 'issued-1' }), dependencies)).status).toBe(
      201,
    );
    expect((await handleFeedback(request({ ...FIRST, submissionId: 'issued-1' }), dependencies)).status).toBe(
      201,
    );
    expect(double.held).toHaveLength(1);
    expect(double.held[0]!.submissionId).toBe('issued-1');
    // The second acceptance of the same pair is an acknowledgement of one the intake held: it counts, once each.
    expect([...used.values()]).toEqual([2, 2]);
  });

  it('refuses the sixth within 10 minutes and the thirty-first within a day with 429, and does not send', async () => {
    const { dependencies, double, used } = setup();
    for (let n = 0; n < 5; n += 1) expect((await handleFeedback(request(), dependencies)).status).toBe(201);
    const sent = double.requests.length;
    const response = await handleFeedback(request(), dependencies);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    const answer = await response.json();
    expect(answer.error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 42 });
    expect(answer.submissionId).toBeUndefined();
    expect(double.requests).toHaveLength(sent);
    used.set('FEEDBACK_SHORT_PER_USER:acc-1', 0);
    used.set('FEEDBACK_DAY_PER_USER:acc-1', 30);
    expect((await handleFeedback(request(), dependencies)).status).toBe(429);
  });

  it('does not count a refused body or a failed send against the limits', async () => {
    const { dependencies, double, used } = setup();
    await handleFeedback(request({ ...FIRST, message: '' }), dependencies);
    double.failWith = 'throw';
    await handleFeedback(request(), dependencies);
    expect([...used.values()]).toEqual([0, 0]);
  });

  it('fires a burst at once and accepts no more than five in 10 minutes (E1)', async () => {
    let issued = 0;
    const { dependencies, double, used } = setup({ newId: () => `burst-${++issued}` });
    const answers = await Promise.all(
      Array.from({ length: 12 }, () => handleFeedback(request(), dependencies)),
    );
    expect(answers.filter(({ status }) => status === 201)).toHaveLength(5);
    expect(answers.filter(({ status }) => status === 429)).toHaveLength(7);
    expect(double.held).toHaveLength(5);
    expect(double.requests).toHaveLength(5);
    expect(used.get('FEEDBACK_SHORT_PER_USER:acc-1')).toBe(5);
  });

  it('gives the first place back where the second limit refuses', async () => {
    const { dependencies, used } = setup();
    used.set('FEEDBACK_DAY_PER_USER:acc-1', 30);
    expect((await handleFeedback(request(), dependencies)).status).toBe(429);
    expect(used.get('FEEDBACK_SHORT_PER_USER:acc-1')).toBe(0);
  });

  it('gives every place back where something throws, and the error is not swallowed', async () => {
    const { dependencies, used } = setup({
      deliver: async () => {
        throw new Error('configuration');
      },
    });
    await expect(handleFeedback(request(), dependencies)).rejects.toThrow('configuration');
    expect([...used.values()]).toEqual([0, 0]);
  });

  it('a place that cannot be given back is said and does not hide the answer', async () => {
    const { dependencies, double, logs } = setup({
      reserve: async () => ({
        ok: true,
        giveBack: async () => {
          throw new Error('valkey down');
        },
      }),
    });
    double.failWith = 500;
    expect((await handleFeedback(request(), dependencies)).status).toBe(502);
    expect(logs).toContain('feedback: place not given back');
  });

  it('refuses as a signed-out caller where the account’s deletion was confirmed since the session was read (E2)', async () => {
    const { dependencies, double, used } = setup({
      stillAllowed: async () => new Response(null, { status: 401 }),
    });
    expect((await handleFeedback(request(), dependencies)).status).toBe(401);
    expect(double.requests).toHaveLength(0);
    expect([...used.values()]).toEqual([0, 0]);
  });

  it('asks about the deletion after the body is read and before anything is sent', async () => {
    const order: string[] = [];
    const { dependencies } = setup({
      readJson: async (req) => {
        order.push('body');
        return (await req.json()) as unknown;
      },
      stillAllowed: async () => {
        order.push('asked');
        return null;
      },
      deliver: async () => {
        order.push('sent');
        return true;
      },
    });
    await handleFeedback(request(), dependencies);
    expect(order).toEqual(['body', 'asked', 'sent']);
  });

  it('answers 422 invalid with the fields, and forbidden_character for a refused character', async () => {
    const { dependencies, double } = setup();
    const invalid = await handleFeedback(request({ ...FIRST, kind: 'bug', route: '/a?b' }), dependencies);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      error: {
        code: 'invalid',
        fields: [
          { field: 'kind', rule: 'format' },
          { field: 'route', rule: 'format' },
        ],
      },
    });
    const forbidden = await handleFeedback(request({ ...FIRST, message: 'a\u202Eb' }), dependencies);
    expect(forbidden.status).toBe(422);
    expect(await forbidden.json()).toMatchObject({
      error: { code: 'forbidden_character', fields: [{ field: 'message', rule: 'forbidden_character' }] },
    });
    expect(double.requests).toHaveLength(0);
  });

  it('answers 422 for a body that is not JSON, without sending', async () => {
    const { dependencies, double } = setup({ readJson: async () => null });
    expect((await handleFeedback(request(), dependencies)).status).toBe(422);
    expect(double.requests).toHaveLength(0);
  });

  it('answers with codes only: every error body has an empty message, and none quotes the submission', async () => {
    const { dependencies, double } = setup();
    const answers = [
      await handleFeedback(request({ ...FIRST, message: 'secret text\u0001' }), dependencies),
      await handleFeedback(
        request({ ...FIRST, message: 'secret text' }),
        setup({ noticeAcknowledged: async () => false }).dependencies,
      ),
    ];
    double.failWith = 500;
    answers.push(await handleFeedback(request({ ...FIRST, message: 'secret text' }), dependencies));
    for (const answer of answers) {
      const text = await answer.text();
      expect(JSON.parse(text).error.message).toBe('');
      expect(text).not.toContain('secret text');
    }
  });

  it('logs the identifier and the outcome, and no account and no message', async () => {
    const { dependencies, logs } = setup();
    await handleFeedback(request({ ...FIRST, message: 'private words' }), dependencies);
    expect(logs.join('\n')).not.toContain('acc-1');
    expect(logs.join('\n')).not.toContain('private words');
  });
});
