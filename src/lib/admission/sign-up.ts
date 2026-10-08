// The acceptance of an admission invitation (FR-AU-90), as an endpoint of the
// application's own inside the identity library. It is there for one reason:
// "it then signs the person in", and a session with its cookie, its address
// and its browser is made by the library inside one of its endpoints
// (tests/integration/identity-library.test.ts, point 1).
//
// The endpoint has no path, so the library's handler cannot route a request to
// it: it is reached only by `auth().api.acceptAdmissionInvitation`, which the
// route `POST /api/sign-up` calls. And it authenticates by the token alone, so
// that even reached by mistake it creates nothing for anyone without one.
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { faultOf } from '../fault.ts';
import { checkPassword } from '../password-rules.ts';
import { acceptInvitation, findOpenInvitation } from './invitations.ts';

export type SignUpResult =
  /** `signedIn` is false where the account stands and its session could not be started. */
  | { outcome: 'created'; signedIn: boolean }
  /** No token, or the token of an invitation that is accepted, revoked, or expired: never said which. */
  | { outcome: 'not_open' }
  | { outcome: 'invalid'; fields: { name?: string; password?: string } };

// Text for a person (the owner's answer to Q6 of the plan).
const NAME_REFUSAL = 'A name has 1 to 100 characters. Enter a name of that length.';

// More than any honest request holds: a token of 43 characters, a name of 100
// and a password of the greatest length (32, as the limit is first set), each
// character at most 4 bytes, and the JSON around them.
const MAX_BODY_BYTES = 4096;

/** The JSON object of a request, or why there is none: the invitation is not looked at for either. */
export type SignUpBody = { json: object } | { refused: 'too_long' | 'not_json' };

/**
 * The body of a request to `POST /api/sign-up`. Bounded, because the path
 * carries no session.
 */
export async function readSignUpBody(request: Request): Promise<SignUpBody> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return { refused: 'too_long' };
      }
      chunks.push(value);
    }
  }
  try {
    const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (typeof json === 'object' && json !== null && !Array.isArray(json)) return { json };
  } catch {
    // Not JSON: answered below, as what is JSON and no object is.
  }
  return { refused: 'not_json' };
}

// The library takes the shape of a body from a schema. This one admits
// anything and says nothing of it: each field is looked at below, by hand.
const anyBody = {
  '~standard': {
    version: 1 as const,
    vendor: 'ekdotico',
    validate: (value: unknown) => ({ value }),
  },
};

export const admissionSignUp = {
  id: 'ekdotico-admission-sign-up',
  endpoints: {
    acceptAdmissionInvitation: createAuthEndpoint(
      { method: 'POST', body: anyBody },
      async (ctx): Promise<SignUpResult> => {
        const body = (ctx.body ?? {}) as { token?: unknown; name?: unknown; password?: unknown };

        // Authorisation before validation (the owner's answer to Q8): whether
        // the invitation is open is settled before anything is said of the name
        // or the password.
        const token = typeof body.token === 'string' ? body.token : '';
        const invitation = await findOpenInvitation(token);
        if (!invitation) return { outcome: 'not_open' };

        // FR-AU-90: "a name, of 1 to 100 characters". Spaces around it are not
        // part of it, and a character is one Unicode code point.
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const fields: { name?: string; password?: string } = {};
        const length = [...name].length;
        // A control character is no character of a name, and PostgreSQL cannot
        // store the first of them.
        if (length < 1 || length > 100 || /[\u0000-\u001f\u007f]/.test(name)) fields.name = NAME_REFUSAL;
        const refusal = checkPassword(password, invitation.email);
        if (refusal) fields.password = refusal;
        if (fields.name || fields.password) return { outcome: 'invalid', fields };

        // NFR-SE-17 (a): the library's own function, scrypt with a salt for each
        // password. Made before the transaction, which it would hold open.
        const passwordHash = await ctx.context.password.hash(password);
        const account = await acceptInvitation({ token, name, passwordHash });
        if (!account) return { outcome: 'not_open' };

        // "It then signs the person in": an ordinary session, with the periods
        // of FR-AU-84. The account stands whether or not this succeeds, so a
        // fault here is not answered as a failure to create it: the person signs
        // in on the sign-in page, where the form sends them. NFR-SE-19: the
        // class of the fault and its code, and nothing else.
        try {
          const user = await ctx.context.internalAdapter.findUserById(account.userId);
          if (!user) throw new Error('The new account was not found.');
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
        } catch (error) {
          console.error(`sign-up: account created, session not started (${faultOf(error)})`);
          return { outcome: 'created', signedIn: false };
        }
        return { outcome: 'created', signedIn: true };
      },
    ),
  },
} satisfies BetterAuthPlugin;
