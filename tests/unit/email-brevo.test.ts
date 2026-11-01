import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Register D262 (Brevo is the email service), FR-AU-87, FR-ED-21, NFR-SE-19. `fetch` is replaced in every
// test: nothing here reaches Brevo, and the key is a marker that is no key.
const ENV = [
  'EMAIL_TRANSPORT',
  'EMAIL_SINK_DIRECTORY',
  'EMAIL_FROM',
  'BREVO_API_KEY',
  'FOUNDING_TEAM_EMAILS',
  'APP_ORIGIN',
  'DATABASE_URL',
  'VALKEY_URL',
  'AUTH_SECRET',
] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

const KEY = 'marker-key-d41f8cd98f00b204e980';
const MESSAGE = {
  to: 'marker.person@example.com',
  subject: 'marker-subject-7f3a',
  text: 'marker-body https://example.com/link/marker-token-91c2',
};
const MARKERS = [KEY, 'marker.person', MESSAGE.subject, 'marker-body', 'marker-token-91c2', 'marker-answer'];
// What Brevo's answer to a refusal can hold: its `message` quotes the email.
const ANSWER = JSON.stringify({
  code: 'invalid_parameter',
  message: 'marker-answer: invalid email marker.person@example.com',
});

// settings() reads the environment once per module instance, so each test imports afresh.
async function load() {
  vi.resetModules();
  // handOver comes with it: it tells MessageRefused by class, and each import has a class of its own.
  const [index, hand] = await Promise.all([
    import('../../src/lib/email/index.ts'),
    import('../../src/lib/email/hand-over.ts'),
  ]);
  return { ...index, handOver: hand.handOver };
}

const fetchMock = vi.fn<typeof fetch>();

const answer = (status: number) => async () => new Response(ANSWER, { status });

beforeEach(() => {
  process.env.EMAIL_TRANSPORT = 'brevo';
  delete process.env.EMAIL_SINK_DIRECTORY;
  process.env.EMAIL_FROM = 'Ekdotico <no-reply@ekdoti.co>';
  process.env.BREVO_API_KEY = KEY;
  process.env.FOUNDING_TEAM_EMAILS = '';
  process.env.APP_ORIGIN = 'http://localhost:3000';
  process.env.DATABASE_URL = 'postgresql://fake:fake@localhost:5432/fake';
  process.env.VALKEY_URL = 'redis://localhost:6379';
  process.env.AUTH_SECRET = 'fake-secret-for-tests-only-0123456789abcdef';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendEmail through Brevo: the request', () => {
  it('posts the sender, one recipient, the subject and the text, with the key in one header', async () => {
    fetchMock.mockImplementation(answer(201));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { sendEmail } = await load();
    await sendEmail(MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init!.method).toBe('POST');
    expect(init!.headers).toEqual({
      'api-key': KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    });
    // A redirect is an error, so the key cannot follow one to another host.
    expect(init!.redirect).toBe('error');
    // And a request that gets no answer is given up on after 10 seconds.
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init!.body as string)).toEqual({
      sender: { name: 'Ekdotico', email: 'no-reply@ekdoti.co' },
      to: [{ email: MESSAGE.to, contactPixelTrackingConsent: false }],
      subject: MESSAGE.subject,
      textContent: MESSAGE.text,
    });
  });

  it('sends no HTML, no reply-to, no tag, no idempotency key and no header of its own', async () => {
    fetchMock.mockImplementation(answer(201));
    const { sendEmail } = await load();
    await sendEmail(MESSAGE);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['sender', 'subject', 'textContent', 'to']);
    for (const absent of ['htmlContent', 'replyTo', 'tags', 'headers', 'params', 'templateId', 'cc', 'bcc']) {
      expect(body).not.toHaveProperty(absent);
    }
    expect(Object.keys(init!.headers as object).sort()).toEqual(['accept', 'api-key', 'content-type']);
  });

  it('puts a quote, a line break and a tag in the message into the JSON and nowhere else', async () => {
    fetchMock.mockImplementation(answer(201));
    const { sendEmail } = await load();
    const text = 'He said "yes".\r\nLine two <b>not html</b>\\';
    await sendEmail({ ...MESSAGE, text });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((JSON.parse(init!.body as string) as { textContent: string }).textContent).toBe(text);
  });

  it.each([
    ['to', { ...MESSAGE, to: 'a@example.com\nBcc: x@example.com' }],
    ['subject', { ...MESSAGE, subject: 'S\r\nBcc: x@example.com' }],
  ])('refuses a line break in %s before any request', async (_field, message) => {
    const { sendEmail, MessageRefused } = await load();
    await expect(sendEmail(message)).rejects.toBeInstanceOf(MessageRefused);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes no file, even where a sink directory is set', async () => {
    fetchMock.mockImplementation(answer(201));
    const root = mkdtempSync(join(tmpdir(), 'ekdotico-brevo-'));
    try {
      process.env.EMAIL_SINK_DIRECTORY = join(root, 'mail');
      const { sendEmail } = await load();
      await sendEmail(MESSAGE);
      expect(existsSync(join(root, 'mail'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('calls fetch for Brevo alone: the sink does not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ekdotico-brevo-'));
    try {
      process.env.EMAIL_TRANSPORT = 'sink';
      process.env.EMAIL_SINK_DIRECTORY = join(root, 'mail');
      const { sendEmail } = await load();
      await sendEmail(MESSAGE);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'mail'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sendEmail through Brevo: the answer', () => {
  it.each([201, 202])('is handed over on %i', async (status) => {
    fetchMock.mockImplementation(answer(status));
    const { sendEmail } = await load();
    await expect(sendEmail(MESSAGE)).resolves.toBeUndefined();
  });

  it('never reads the answer, and lets go of it', async () => {
    const cancel = vi.fn(async () => {});
    const never = () => {
      throw new Error('the answer was read');
    };
    fetchMock.mockResolvedValue({
      status: 201,
      body: { cancel },
      text: never,
      json: never,
      arrayBuffer: never,
      clone: never,
    } as unknown as Response);
    const { sendEmail } = await load();
    await sendEmail(MESSAGE);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses the message on 400, and handOver does not try again', async () => {
    fetchMock.mockImplementation(answer(400));
    const { sendEmail, handOver, MessageRefused } = await load();
    await expect(sendEmail(MESSAGE)).rejects.toBeInstanceOf(MessageRefused);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const wait = vi.fn(async () => {});
    expect(await handOver(MESSAGE, 'invitation x', sendEmail, wait)).toBe(false);
    expect(wait).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2); // one for each of the two calls above
  });

  it.each([401, 403, 404, 408, 429, 500, 502, 503, 200])(
    'throws a plain error on %i, which handOver tries again',
    async (status) => {
      fetchMock.mockImplementationOnce(answer(status)).mockImplementation(answer(201));
      const { sendEmail, handOver, MessageRefused } = await load();
      const error = await sendEmail(MESSAGE).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MessageRefused);
      expect(error!.message).toBe(`Brevo answered with status ${status}.`);

      fetchMock.mockReset();
      fetchMock.mockImplementationOnce(answer(status)).mockImplementation(answer(201));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const waits: number[] = [];
      expect(await handOver(MESSAGE, undefined, sendEmail, async (ms) => void waits.push(ms))).toBe(true);
      expect(waits).toEqual([5_000]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('throws a plain error on a timeout and on a network fault, which handOver tries again', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    for (const fault of [timeout, refused]) {
      fetchMock.mockReset();
      fetchMock.mockRejectedValueOnce(fault).mockImplementation(answer(201));
      const { sendEmail, handOver, MessageRefused } = await load();
      const error = await sendEmail(MESSAGE).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MessageRefused);

      fetchMock.mockReset();
      fetchMock.mockRejectedValueOnce(fault).mockImplementation(answer(201));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await handOver(MESSAGE, undefined, sendEmail, async () => {})).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it('does not try again by itself: one request for one call, whatever the fault', async () => {
    fetchMock.mockImplementation(answer(503));
    const { sendEmail } = await load();
    await sendEmail(MESSAGE).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// NFR-SE-19: no error message or cause, and no line of a log, holds the address, the subject, the body,
// the token in it, the key, or what Brevo answered. The status is all that may appear.
describe('sendEmail through Brevo: what no fault holds', () => {
  const quoting = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});
  // Every way a request can fail, each carrying every marker in the places a library puts them: the message,
  // the cause, a property of the cause, and the request itself.
  const FAILURES: [string, () => Promise<Response>][] = [
    ['400', answer(400)],
    ['401', answer(401)],
    ['429', answer(429)],
    ['500', answer(500)],
    [
      'a timeout',
      async () => Promise.reject(new DOMException(`aborted ${MARKERS.join(' ')}`, 'TimeoutError')),
    ],
    [
      'a refusal to connect',
      async () =>
        Promise.reject(
          Object.assign(new TypeError(`fetch failed ${MARKERS.join(' ')}`), {
            cause: Object.assign(quoting(`connect ECONNREFUSED ${MARKERS.join(' ')}`, 'ECONNREFUSED'), {
              request: { headers: { 'api-key': KEY }, body: MESSAGE },
            }),
          }),
        ),
    ],
    [
      'an unexpected redirect',
      async () =>
        Promise.reject(
          Object.assign(new TypeError('fetch failed'), {
            cause: quoting(`unexpected redirect https://evil.example/?k=${KEY}`, 'UND_ERR_REDIRECT'),
          }),
        ),
    ],
    [
      'a fault whose code is the key',
      async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: KEY } })),
    ],
  ];

  // Everything an error holds that a log or a page could print: the chain of causes, each with its class,
  // message, stack, own properties, and its string form.
  function everything(error: unknown): string {
    const seen: string[] = [];
    for (let each = error as { cause?: unknown } | undefined; each; each = each.cause as typeof each) {
      const e = each as Error;
      seen.push(String(e), e.name ?? '', e.message ?? '', e.stack ?? '');
      for (const name of Object.getOwnPropertyNames(e)) {
        if (name !== 'cause')
          seen.push(JSON.stringify((e as unknown as Record<string, unknown>)[name]) ?? '');
      }
    }
    return seen.join('\n');
  }

  it.each(FAILURES)('after %s, the error holds none of them, at any depth', async (_name, fail) => {
    fetchMock.mockImplementation(fail);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const { sendEmail } = await load();
    const error = await sendEmail(MESSAGE).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const held = everything(error);
    for (const marker of MARKERS) expect(held).not.toContain(marker);
    // The cause of a fault of `fetch` is not kept at all.
    expect((error as Error).cause).toBeUndefined();
    // And the sender itself writes nothing to the console.
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it.each(FAILURES)('after %s, handOver prints none of them either', async (_name, fail) => {
    fetchMock.mockImplementation(fail);
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const { sendEmail, handOver } = await load();
    await handOver(MESSAGE, 'invitation cm0000000000000000000000', sendEmail, async () => {});
    const output = JSON.stringify(logged.flatMap((spy) => spy.mock.calls));
    expect(output).toContain('email: ');
    for (const marker of MARKERS) expect(output).not.toContain(marker);
  });

  it('names only the class and the status or the code of a fault, for the one line handOver prints', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sendEmail, handOver } = await load();
    fetchMock.mockImplementation(answer(429));
    await handOver(MESSAGE, undefined, sendEmail, async () => {});
    expect(spy.mock.calls[0]).toEqual(['email: hand-over failed, trying again (Error 429)']);

    spy.mockClear();
    fetchMock.mockImplementation(FAILURES.find(([name]) => name === 'a timeout')![1]);
    await handOver(MESSAGE, undefined, sendEmail, async () => {});
    expect(spy.mock.calls[0]).toEqual(['email: hand-over failed, trying again (Error Timeout)']);

    spy.mockClear();
    fetchMock.mockImplementation(FAILURES.find(([name]) => name === 'a refusal to connect')![1]);
    await handOver(MESSAGE, undefined, sendEmail, async () => {});
    expect(spy.mock.calls[0]).toEqual(['email: hand-over failed, trying again (Error ECONNREFUSED)']);
  });
});
