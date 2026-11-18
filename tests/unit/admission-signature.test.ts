// The wire format of docs/contracts/admission-signature.md, which is
// provisional and Praktico's to restate. Its two worked examples are held here
// so that a second implementation can check itself against the page. The
// signature covers a nonce of at least 128 bits (FR-AU-89; register D299; docs@da33e58).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_BYTES,
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
  signedHeaders,
  verify,
  verifyRequest,
  type SignedParts,
} from '../../src/lib/admission/signature.ts';

// "Too short to be accepted as a real one and exists only for these two vectors."
const SECRET = 'test-secret-not-for-use';
const TIME = '1791450000';
const NOW = Number(TIME) * 1000;
const NONCE = '00112233445566778899aabbccddeeff';
const PATH = '/api/admission/invitations';
const BODY = new TextEncoder().encode(
  '{"email":"person@example.com","requestId":"0b9f6c1e-5d1c-4a55-9d53-1f3a2f6f7a10"}',
);
// Computed twice, by Node's HMAC and by Python's, from the message of the page.
const GET_SIGNATURE = 'd967fd079c2f6059279021c13d4036aea9e6b62c931a61056359711a18b45900';
const POST_SIGNATURE = '1725a12b8ecae5ebd8b0aaea01abc244d1379e6ff8f7c79d4e75e2fa8f862865';

const get: SignedParts = {
  method: 'GET',
  target: PATH,
  timestamp: TIME,
  nonce: NONCE,
  signature: GET_SIGNATURE,
  body: new Uint8Array(),
};
const post: SignedParts = {
  method: 'POST',
  target: PATH,
  timestamp: TIME,
  nonce: NONCE,
  signature: POST_SIGNATURE,
  body: BODY,
};

describe('the two worked examples of the contract page', () => {
  it('signs the GET without a body', () => {
    expect(sign(SECRET, TIME, NONCE, 'GET', PATH)).toBe(GET_SIGNATURE);
  });

  it('signs the POST with its 81-byte body', () => {
    expect(BODY.byteLength).toBe(81);
    expect(sign(SECRET, TIME, NONCE, 'POST', PATH, BODY)).toBe(POST_SIGNATURE);
  });

  it('is HMAC-SHA-256 over the four lines and then the body', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`${TIME}\n${NONCE}\nPOST\n${PATH}\n`)
      .update(BODY)
      .digest('hex');
    expect(expected).toBe(POST_SIGNATURE);
  });

  it('verifies both', () => {
    expect(verify(SECRET, get, NOW)).toBe(true);
    expect(verify(SECRET, post, NOW)).toBe(true);
  });
});

describe('the nonce is covered by the signature and has the form of the page (D299)', () => {
  const refused = (change: Partial<SignedParts>, base = post) =>
    expect(verify(SECRET, { ...base, ...change }, NOW)).toBe(false);

  // Weakening: the nonce is read from a header and left out of the signed message, so that a replay could change it.
  it('refuses another nonce under the same signature', () => {
    refused({ nonce: 'ffeeddccbbaa99887766554433221100' });
    refused({ nonce: '1'.repeat(32) });
  });

  it('refuses a request without a nonce, even where the signature was made without one', () => {
    refused({ nonce: null });
    const bare = createHmac('sha256', SECRET).update(`${TIME}\nPOST\n${PATH}\n`).update(BODY).digest('hex');
    refused({ nonce: null, signature: bare });
  });

  it.each([
    ['31 digits, which is under 128 bits', NONCE.slice(1)],
    ['65 digits', `${NONCE}${NONCE}0`],
    ['upper-case hexadecimal, which is not folded', NONCE.toUpperCase()],
    ['a letter outside hexadecimal', `g${NONCE.slice(1)}`],
    ['a header sent twice, as Headers joins it', `${NONCE}, ${NONCE}`],
    ['nothing', ''],
  ])('a nonce of %s, even where it was signed so', (_, nonce) => {
    refused({ nonce, signature: sign(SECRET, TIME, nonce, 'POST', PATH, BODY) });
  });

  it('accepts a nonce of 32 and of 64 digits', () => {
    for (const nonce of [NONCE, NONCE + NONCE]) {
      expect(
        verify(SECRET, { ...post, nonce, signature: sign(SECRET, TIME, nonce, 'POST', PATH, BODY) }, NOW),
      ).toBe(true);
    }
  });

  it('is made fresh for each request, from 128 bits', () => {
    const first = signedHeaders(SECRET, 'GET', PATH, undefined, NOW)[NONCE_HEADER]!;
    const second = signedHeaders(SECRET, 'GET', PATH, undefined, NOW)[NONCE_HEADER]!;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });
});

describe('verification refuses', () => {
  const refused = (
    change: Partial<SignedParts>,
    base = post,
    now = NOW,
    secret: string | undefined = SECRET,
  ) => expect(verify(secret, { ...base, ...change }, now)).toBe(false);

  it('every request where no secret is configured', () => {
    expect(verify(undefined, post, NOW)).toBe(false);
    refused({}, post, NOW, '');
    // Even a signature made with the empty key.
    refused({ signature: sign('', TIME, NONCE, 'POST', PATH, BODY) }, post, NOW, '');
  });

  it('another secret', () => {
    refused({}, post, NOW, `${SECRET}x`);
  });

  it('a header that is absent', () => {
    refused({ timestamp: null });
    refused({ signature: null });
  });

  it.each([
    ['nine digits', '179145000'],
    ['eleven digits', '17914500000'],
    ['a leading zero', '0791450000'],
    ['a sign', '+791450000'],
    ['a fraction', '1791450000.0'],
    ['a space after', '1791450000 '],
    ['a header sent twice, as Headers joins it', '1791450000, 1791450000'],
    ['nothing', ''],
  ])('a timestamp with %s', (_, timestamp) => {
    refused({ timestamp });
  });

  it.each([
    ['upper-case hexadecimal, which is not folded', POST_SIGNATURE.toUpperCase()],
    ['63 digits', POST_SIGNATURE.slice(1)],
    ['65 digits', `${POST_SIGNATURE}0`],
    ['a prefix', `sha256=${POST_SIGNATURE}`],
    ['a letter outside hexadecimal', `g${POST_SIGNATURE.slice(1)}`],
    ['a header sent twice, as Headers joins it', `${POST_SIGNATURE}, ${POST_SIGNATURE}`],
    ['nothing', ''],
  ])('a signature with %s', (_, signature) => {
    refused({ signature });
  });

  it('a signature that differs in one digit', () => {
    const last = POST_SIGNATURE.at(-1) === '0' ? '1' : '0';
    refused({ signature: POST_SIGNATURE.slice(0, -1) + last });
  });

  it.each([
    ['a query string', `${PATH}?a=1`],
    ['an empty query string', `${PATH}?`],
    ['a trailing slash', `${PATH}/`],
    ['percent-encoding', '/api/admission/invitations/a%2Fb'],
    ['an identifier of 65 characters', `${PATH}/${'a'.repeat(65)}`],
    ['an identifier with a dot', `${PATH}/a.b`],
    ['a second segment', `${PATH}/a/b`],
    ['another path', '/api/admission/invitation'],
    ['another case', '/API/admission/invitations'],
  ])('a target with %s, even where it was signed so', (_, target) => {
    refused({ target, signature: sign(SECRET, TIME, NONCE, 'GET', target) }, get);
  });

  it('a method outside the three, even where it was signed so', () => {
    for (const method of ['PUT', 'PATCH', 'HEAD', 'get', 'post']) {
      refused({ method, signature: sign(SECRET, TIME, NONCE, method, PATH) }, get);
    }
  });

  it('the signature of another method, path, or time', () => {
    refused({ method: 'DELETE' });
    refused({ target: `${PATH}/abc` });
    refused({ timestamp: '1791450001' });
  });

  it('a body altered after signing, by one byte', () => {
    const altered = Uint8Array.from(BODY);
    altered[10] = altered[10]! ^ 1;
    refused({ body: altered });
    refused({ body: BODY.slice(0, -1) });
    refused({ body: new Uint8Array() });
    // Parsed and written out again: the same JSON, other bytes.
    const rewritten = new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(BODY)), null, 1),
    );
    refused({ body: rewritten });
  });

  it('a body of more than 4,096 bytes, even where it was signed so', () => {
    const fits = new Uint8Array(MAX_BODY_BYTES).fill(0x20);
    const tooLong = new Uint8Array(MAX_BODY_BYTES + 1).fill(0x20);
    expect(
      verify(SECRET, { ...post, body: fits, signature: sign(SECRET, TIME, NONCE, 'POST', PATH, fits) }, NOW),
    ).toBe(true);
    refused({ body: tooLong, signature: sign(SECRET, TIME, NONCE, 'POST', PATH, tooLong) });
  });

  it('a time more than 300 seconds from its own, on either side', () => {
    expect(verify(SECRET, post, NOW + 300_000)).toBe(true);
    expect(verify(SECRET, post, NOW - 300_000)).toBe(true);
    // The application's clock in whole seconds: 300.999 s is still 300.
    expect(verify(SECRET, post, NOW + 300_999)).toBe(true);
    refused({}, post, NOW + 301_000);
    refused({}, post, NOW - 301_000);
    // A replay, a day on.
    refused({}, post, NOW + 24 * 60 * 60 * 1000);
  });
});

describe('a request as it is received', () => {
  const ORIGIN = 'https://app.example.test';
  const request = (
    method: string,
    target: string,
    headers: Record<string, string>,
    body?: Uint8Array<ArrayBuffer>,
  ) => new Request(ORIGIN + target, { method, headers, body });

  it('yields the bytes of the body, the nonce and the signed time where it verifies', async () => {
    const headers = signedHeaders(SECRET, 'POST', PATH, BODY, NOW, NONCE);
    expect(headers).toEqual({
      [TIMESTAMP_HEADER]: TIME,
      [NONCE_HEADER]: NONCE,
      [SIGNATURE_HEADER]: POST_SIGNATURE,
    });
    const verified = await verifyRequest(request('POST', PATH, headers, BODY), SECRET, NOW);
    expect(Buffer.from(verified!.body).equals(Buffer.from(BODY))).toBe(true);
    expect(verified).toMatchObject({ nonce: NONCE, signedAt: Number(TIME) });
    const bare = await verifyRequest(
      request('GET', PATH, signedHeaders(SECRET, 'GET', PATH, undefined, NOW)),
      SECRET,
      NOW,
    );
    expect(bare?.body).toEqual(new Uint8Array());
  });

  it('refuses a query string that the signature did not cover', async () => {
    const headers = signedHeaders(SECRET, 'GET', PATH, undefined, NOW);
    expect(await verifyRequest(request('GET', `${PATH}?a=1`, headers), SECRET, NOW)).toBeNull();
    expect(await verifyRequest(request('GET', `${PATH}?`, headers), SECRET, NOW)).toBeNull();
  });

  it('refuses a header sent twice', async () => {
    const headers = new Headers(signedHeaders(SECRET, 'GET', PATH, undefined, NOW));
    headers.append(SIGNATURE_HEADER, GET_SIGNATURE);
    expect(await verifyRequest(new Request(ORIGIN + PATH, { headers }), SECRET, NOW)).toBeNull();
  });

  it('refuses a request whose nonce header was taken away, or changed after signing', async () => {
    const headers = signedHeaders(SECRET, 'GET', PATH, undefined, NOW, NONCE);
    const without = { ...headers };
    delete without[NONCE_HEADER];
    expect(await verifyRequest(request('GET', PATH, without), SECRET, NOW)).toBeNull();
    const changed = { ...headers, [NONCE_HEADER]: 'f'.repeat(32) };
    expect(await verifyRequest(request('GET', PATH, changed), SECRET, NOW)).toBeNull();
  });

  it('refuses without the headers, without a secret, and outside the 5 minutes', async () => {
    const headers = signedHeaders(SECRET, 'GET', PATH, undefined, NOW);
    expect(await verifyRequest(request('GET', PATH, {}), SECRET, NOW)).toBeNull();
    expect(await verifyRequest(request('GET', PATH, headers), undefined, NOW)).toBeNull();
    expect(await verifyRequest(request('GET', PATH, headers), SECRET, NOW + 301_000)).toBeNull();
  });

  it('stops reading a body that is too long, whatever its declared length', async () => {
    const tooLong = new Uint8Array(MAX_BODY_BYTES + 1).fill(0x20);
    const headers = signedHeaders(SECRET, 'POST', PATH, tooLong, NOW);
    expect(await verifyRequest(request('POST', PATH, headers, tooLong), SECRET, NOW)).toBeNull();
    // A stream, which declares no length: read no further than the limit.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const streamed = new Request(ORIGIN + PATH, {
      method: 'POST',
      headers,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(await verifyRequest(streamed, SECRET, NOW)).toBeNull();
    expect(pulled).toBeLessThan(10);
  });
});
