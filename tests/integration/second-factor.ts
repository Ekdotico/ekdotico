// What the integration tests of two-factor authentication share: a browser's
// cookies across several answers, the secret as an authenticator application
// holds it, and an enrolment made as a person makes one (FR-AU-83).
import { totpAt, totpStep } from '../../src/lib/auth/two-factor.ts';
import { handle, ORIGIN, PASSWORD, post, signIn, type load } from './identity.ts';

type Auth = Awaited<ReturnType<typeof load>>['auth'];

/**
 * The Cookie header of a browser that held `cookie` and then received this
 * response: a cookie that is set replaces its earlier value, and one that is
 * cleared is gone.
 */
export function withCookies(cookie: string, response: { headers: Headers }): string {
  const held = new Map(
    cookie
      .split('; ')
      .filter(Boolean)
      .map((each) => [each.slice(0, each.indexOf('=')), each.slice(each.indexOf('=') + 1)] as const),
  );
  for (const set of response.headers.getSetCookie()) {
    const pair = set.split(';')[0]!;
    const name = pair.slice(0, pair.indexOf('='));
    const value = pair.slice(pair.indexOf('=') + 1);
    if (value === '' || /max-age=0/i.test(set)) held.delete(name);
    else held.set(name, value);
  }
  return [...held].map(([name, value]) => `${name}=${value}`).join('; ');
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 4648: the secret as it is typed into an authenticator application, back to the text it stands for. */
export function unbase32(text: string): string {
  const bits = [...text].map((letter) => ALPHABET.indexOf(letter).toString(2).padStart(5, '0')).join('');
  const bytes = (bits.match(/.{8}/g) ?? []).map((eight) => parseInt(eight, 2));
  return Buffer.from(bytes).toString();
}

/** The code an authenticator application shows for this secret, `steps` steps of 30 seconds from now. */
export const codeAt = (secret: string, steps = 0) => totpAt(secret, totpStep() + steps);

const taken = new Map<string, Set<number>>();
/**
 * A code of this secret that would be accepted now and that no earlier call
 * gave out. A code is accepted once (RFC 6238, 5.2), so a test that signs one
 * account in twice needs two: the code of this step, then that of the next,
 * then that of the one before, which is the first to stop being accepted.
 */
export function nextCode(secret: string): string {
  const now = totpStep();
  const spent = taken.get(secret) ?? new Set<number>();
  taken.set(secret, spent);
  const step = [now, now + 1, now - 1].find((each) => !spent.has(each));
  if (step === undefined)
    throw new Error('No code of this secret is left in this step: use another account.');
  spent.add(step);
  return totpAt(secret, step);
}

/** Waits, where a step of 30 seconds is about to end, until the next has begun: for a test that names steps. */
export async function midStep(): Promise<void> {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 6_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

export interface Enrolled {
  /** The secret, as the text the authenticator computes from. */
  secret: string;
  recoveryCodes: string[];
  /** The browser's cookies after the enrolment, with the fresh signed copy. */
  cookie: string;
}

/**
 * Turns two-factor authentication on for the account of this browser, as a
 * person does: the password, then the first code, which `nextCode` gives.
 */
export async function enrol(
  auth: Auth,
  cookie: string,
  headers: Record<string, string> = {},
): Promise<Enrolled> {
  const begun = await post(auth, '/two-factor/enable', { password: PASSWORD }, { cookie, ...headers });
  if (begun.response.status !== 200) throw new Error(`enable answered ${begun.response.status}`);
  const secret = unbase32(((await begun.response.json()) as { secret: string }).secret);
  const confirmed = await post(
    auth,
    '/two-factor/verify-totp',
    { code: nextCode(secret) },
    { cookie, ...headers },
  );
  if (confirmed.response.status !== 200) throw new Error(`verify-totp answered ${confirmed.response.status}`);
  const { recoveryCodes } = (await confirmed.response.json()) as { recoveryCodes: string[] };
  await confirmed.after();
  return { secret, recoveryCodes, cookie: withCookies(cookie, confirmed.response) };
}

/** The password step of a sign-in for an account with a second factor: the cookie of the step that it leaves. */
export async function passwordStep(auth: Auth, email: string, headers: Record<string, string> = {}) {
  const response = await signIn(auth, email, PASSWORD, headers);
  if (response.status !== 200) throw new Error(`sign-in answered ${response.status}`);
  return withCookies(headers.cookie ?? '', response);
}

/** A request of the second step, through the handler as the route makes it. */
export function secondStep(
  auth: Auth,
  cookie: string,
  code: unknown,
  kind: 'totp' | 'backup-code' = 'totp',
  headers: Record<string, string> = {},
) {
  return handle(
    auth,
    new Request(`${ORIGIN}/api/auth/two-factor/verify-${kind}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie, ...headers },
      body: JSON.stringify({ code }),
    }),
  );
}
