// A stand-in for the feedback intake of Praktico, behind the same client: a `fetch` that verifies what the
// application signs the way docs/contracts/feedback-intake.md says Praktico does, in order, and answers as the
// contract does. It runs in the test's process: no service, no network. Nothing of Praktico's is built here
// beyond what the tests need to see the application's requests accepted or refused.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface Held {
  submissionId: string;
  accountId: string | null;
  body: Record<string, unknown>;
}

export interface Double {
  fetch: typeof fetch;
  /** Every request received, in order, as verified. */
  requests: { path: string; headers: Headers; body: string }[];
  held: Held[];
  /** Nonces spent. */
  nonces: Set<string>;
  /** Set to make the next answers fail: a status, `'hang'` for no answer, `'throw'` for a closed connection. */
  failWith: number | 'hang' | 'throw' | null;
  /** The body of the next answer, in place of the contract's. */
  answerWith: unknown;
}

const PATHS = ['/praktico/api/feedback/intake', '/praktico/api/feedback/pseudonymise'];

export function praktico(secret: string, now: () => number = Date.now): Double {
  const double: Double = {
    requests: [],
    held: [],
    nonces: new Set(),
    failWith: null,
    answerWith: undefined,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = Buffer.from(init?.body as Buffer).toString('utf8');
      const headers = new Headers(init?.headers);
      double.requests.push({ path: url.pathname, headers, body });
      if (double.failWith === 'throw') throw new TypeError('closed');
      if (double.failWith === 'hang') {
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
        );
      }
      if (typeof double.failWith === 'number') return Response.json({}, { status: double.failWith });
      const unauthorised = () => Response.json({ error: { code: 'unauthorised' } }, { status: 401 });
      // Verification, in order: the form of each part, the time, the signature, the nonce.
      const timestamp = headers.get('x-ekdotico-timestamp') ?? '';
      const nonce = headers.get('x-ekdotico-nonce') ?? '';
      const signature = headers.get('x-ekdotico-signature') ?? '';
      if (
        !PATHS.includes(url.pathname) ||
        url.search !== '' ||
        init?.method !== 'POST' ||
        !/^[1-9][0-9]{9}$/.test(timestamp) ||
        !/^[0-9a-f]{32,64}$/.test(nonce) ||
        !/^[0-9a-f]{64}$/.test(signature)
      )
        return unauthorised();
      if (Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > 300) return unauthorised();
      const expected = createHmac('sha256', Buffer.from(secret, 'utf8'))
        .update(`${timestamp}\n${nonce}\nPOST\n${url.pathname}\n${body}`, 'utf8')
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return unauthorised();
      if (double.nonces.has(nonce)) return unauthorised();
      double.nonces.add(nonce);

      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (double.answerWith !== undefined) return Response.json(double.answerWith, { status: 200 });
      if (url.pathname.endsWith('/pseudonymise')) {
        const rows = double.held.filter((row) => row.accountId === parsed.accountId);
        for (const row of rows) row.accountId = null;
        return Response.json({ accepted: true, changed: rows.length });
      }
      const duplicate = double.held.some(
        (row) => row.submissionId === parsed.submissionId && row.accountId === parsed.accountId,
      );
      if (!duplicate)
        double.held.push({
          submissionId: parsed.submissionId as string,
          accountId: parsed.accountId as string,
          body: parsed,
        });
      return Response.json({ accepted: true, duplicate }, { status: duplicate ? 200 : 201 });
    },
  };
  return double;
}
