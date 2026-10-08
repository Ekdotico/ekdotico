// The admission command (FR-AU-57, FR-AU-89; register D110, D113): a small
// client of the three admission endpoints and nothing more. It builds the
// request of its action, signs it with the admission secret, sends it to the
// application, and prints the answer. It reads no table and writes no row, so
// an invitation is created by one code path whoever asks; and it prints
// neither the token nor the link, which the endpoints do not return.
//
//   node --env-file=.env.local scripts/admission.ts create person@example.com
//   node --env-file=.env.local scripts/admission.ts list
//   node --env-file=.env.local scripts/admission.ts revoke <id>
//
// It runs under plain Node and imports the signature module alone: no
// settings, no database.
import { randomUUID } from 'node:crypto';
import { INVITATIONS_PATH, signedHeaders } from '../src/lib/admission/signature.ts';

const USAGE = `Usage:
  node --env-file=.env.local scripts/admission.ts create <email>
  node --env-file=.env.local scripts/admission.ts list
  node --env-file=.env.local scripts/admission.ts revoke <id>`;

type Env = Record<string, string | undefined>;

/** Runs one action and returns the exit code. The last three parameters are for the tests. */
export async function run(
  args: readonly string[],
  env: Env = process.env,
  send: typeof fetch = fetch,
  print: (line: string) => void = console.log,
): Promise<number> {
  const [action, argument, ...rest] = args;
  const known =
    (action === 'list' && argument === undefined) ||
    ((action === 'create' || action === 'revoke') && argument !== undefined && rest.length === 0);
  if (!known) {
    print(USAGE);
    return 2;
  }
  const secret = env.ADMISSION_SECRET;
  const origin = env.APP_ORIGIN;
  if (!secret || !origin) {
    print('ADMISSION_SECRET and APP_ORIGIN must be set, as they are for the application.');
    return 2;
  }
  // "Over HTTPS": the request carries an address. Plain HTTP reaches a
  // development machine and nothing else, as for the application itself.
  const { protocol, hostname } = new URL(origin);
  if (protocol !== 'https:' && !(protocol === 'http:' && ['localhost', '127.0.0.1'].includes(hostname))) {
    print('APP_ORIGIN must use https, except on localhost.');
    return 2;
  }

  let method = 'GET';
  let path = INVITATIONS_PATH;
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (action === 'create') {
    method = 'POST';
    // The request identifier of FR-AU-89 (a), issued here: one for each invitation intended.
    body = new TextEncoder().encode(JSON.stringify({ email: argument, requestId: randomUUID() }));
  } else if (action === 'revoke') {
    method = 'DELETE';
    path = `${INVITATIONS_PATH}/${argument}`;
  }

  // The bytes signed are the bytes sent.
  let response: Response;
  try {
    response = await send(new URL(origin).origin + path, {
      method,
      headers: {
        ...signedHeaders(secret, method, path, body),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      redirect: 'error',
    });
  } catch {
    print('The application did not answer. Check that it is running and that APP_ORIGIN is its origin.');
    return 1;
  }
  const text = await response.text();
  let answer: string;
  try {
    answer = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    answer = text;
  }
  print(`${response.status}\n${answer}`);
  return response.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2));
}
