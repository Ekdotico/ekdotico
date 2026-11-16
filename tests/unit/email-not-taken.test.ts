// D263, NFR-RE-15: which answers of the service mean it CERTAINLY did not take an email, through the real sender with
// `fetch` replaced: nothing here reaches Brevo, and the key is a marker that is no key.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
const MESSAGE = { to: 'a.person@example.com', subject: 'A subject', text: 'A text' };

const fetchMock = vi.fn<typeof fetch>();
const status =
  (code: number, body: unknown = {}) =>
  async () =>
    new Response(JSON.stringify(body), { status: code });
const refused = (code: string) => async () =>
  Promise.reject(
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) }),
  );

beforeEach(() => {
  Object.assign(process.env, {
    EMAIL_TRANSPORT: 'brevo',
    EMAIL_FROM: 'Ekdotico <no-reply@ekdoti.co>',
    BREVO_API_KEY: 'marker-key-d41f8cd98f00b204e980',
    FOUNDING_TEAM_EMAILS: '',
    APP_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fake',
    VALKEY_URL: 'redis://localhost:6379',
    AUTH_SECRET: 'fake-secret-for-tests-only-0123456789abcdef',
  });
  delete process.env.EMAIL_SINK_DIRECTORY;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.unstubAllGlobals();
});

async function faultOf(answer: () => Promise<Response>) {
  vi.resetModules();
  const { sendEmail, certainlyNotTaken } = await import('../../src/lib/email/index.ts');
  fetchMock.mockImplementation(answer);
  const error = await sendEmail(MESSAGE).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return certainlyNotTaken(error);
}

it.each([
  ['401', status(401)],
  ['402', status(402)],
  ['403', status(403)],
  ['429', status(429)],
  ['a 400 for its credits', status(400, { code: 'not_enough_credits' })],
  ['a 400 for its key', status(400, { code: 'api-key not found' })],
  ['a 400 for its domain', status(400, { code: 'Domain does not exist' })],
  ['no connection: refused', refused('ECONNREFUSED')],
  ['no connection: no such host', refused('ENOTFOUND')],
])('after %s the service certainly did not take it', async (_name, answer) => {
  expect(await faultOf(answer)).toBe(true);
});

it.each([
  ['a 500', status(500)],
  ['a 502', status(502)],
  ['a 503', status(503)],
  ['a 504', status(504)],
  ['a timeout', async () => Promise.reject(new DOMException('aborted', 'TimeoutError'))],
  ['a connect timeout', refused('UND_ERR_CONNECT_TIMEOUT')],
  ['a broken connection', refused('ECONNRESET')],
  ['a closed socket', refused('UND_ERR_SOCKET')],
  ['a 400 for the message itself', status(400, { code: 'invalid_parameter' })],
  ['a 400 it has seen already', status(400, { code: 'duplicate_request' })],
  ['a 400 of no listed code', status(400, { code: 'something_new' })],
  ['a 400 with no body', async () => new Response('not json', { status: 400 })],
  ['a 400 for a permission', status(400, { code: 'permission_denied' })],
  ['a 404', status(404)],
])('after %s the outcome is unknown or the message is refused: not tried again', async (_name, answer) => {
  expect(await faultOf(answer)).toBe(false);
});

it('a fault with no code, and a value that is no fault, are not certain', async () => {
  const { certainlyNotTaken } = await import('../../src/lib/email/index.ts');
  expect(certainlyNotTaken(new Error('This process holds no key for Brevo.'))).toBe(false);
  expect(certainlyNotTaken(undefined)).toBe(false);
  expect(certainlyNotTaken(null)).toBe(false);
  expect(certainlyNotTaken('401')).toBe(false);
});
