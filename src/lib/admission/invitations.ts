// Admission invitations (FR-AU-57, FR-AU-89, FR-AU-90): created, listed and
// revoked on a signed request, and accepted once, by the person the link
// reached. This is the one code path that writes an invitation, whoever asks.
//
// NFR-SE-19: nothing here logs, and no error made here holds an address or a
// token. The token leaves this module once, inside the email of FR-AU-87 (a).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AdmissionInvitation } from '../../generated/prisma/client.ts';
import { db } from '../db.ts';
import type { EmailMessage } from '../email/index.ts';
import { settings } from '../settings.ts';
import { createPersonalWorkspace } from '../workspace.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** An invitation as the endpoints return it (docs/contracts/admission-signature.md, "An invitation"). */
export interface InvitationView {
  id: string;
  /** Absent once the address has been cleared. */
  email?: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
}

// The columns an answer is made from, and no other: the hash of the token is
// never read into a row that is on its way out (FR-AU-89: "neither the token
// nor the link is returned").
const VIEW = { id: true, email: true, state: true, createdAt: true, expiresAt: true } as const;
type Row = Pick<AdmissionInvitation, keyof typeof VIEW>;

/**
 * "Expired" is derived, not stored: an invitation is pending only while the
 * row says PENDING and its expiry is ahead. So it stops being open at the
 * moment it expires, on every instance, with no timer to wait for.
 */
function view(row: Row, now: Date): InvitationView {
  const state = row.state === 'PENDING' && row.expiresAt <= now ? 'EXPIRED' : row.state;
  return {
    id: row.id,
    ...(row.email === null ? {} : { email: row.email }),
    state: state.toLowerCase() as InvitationView['state'],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

// 256 bits from the platform's cryptographic source (FR-AU-89 asks for 128 or
// more), written in the URL-safe alphabet: 43 characters, which is what the
// allow-list of proxy.ts takes a `[token]` to be made of.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const newToken = () => randomBytes(32).toString('base64url');

// Stored only as this hash. A plain SHA-256 is sound here, where it would not
// be for a password: the token is 256 random bits, so there is nothing to
// guess and nothing a salt or a slow function would add. The row is found by
// the hash, through its unique index; no comparison of secrets is made in code.
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

// What the address of an invitation must look like. FR-AU-89 says "an email
// address" and no more; this refuses what could not be one, and anything that
// could break a header of the message. Lower case, as it is stored (FR-AU-02).
const ADDRESS = /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

// FR-AU-87 (a), verbatim. Plain text; it carries nothing of a person but the
// address it is sent to.
function invitationEmail(to: string, token: string): EmailMessage {
  const link = `${settings().appOrigin}/sign-up/${token}`;
  return {
    to,
    subject: 'Your invitation to Ekdotico Closed α',
    text: `The Ekdotico team has invited you to test Ekdotico in Closed α. To create your account, open this link and choose a password: ${link}. The link works once and is valid for 30 days. If you did not expect this invitation, you can ignore this email.`,
  };
}

const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2002';
// A unique index refused the row, or the database chose this transaction to
// end a deadlock or a write conflict: in each case nothing was written.
const isConflict = (error: unknown) =>
  isUniqueViolation(error) || (error as { code?: unknown } | null)?.code === 'P2034';
const CREATE_ATTEMPTS = 10;

export type CreateResult =
  /** Created. `message` is the email, for the caller to hand over once it has answered. */
  | { outcome: 'created'; invitation: InvitationView; message: EmailMessage }
  /** The same request identifier was sent before, with the same address: nothing changed. */
  | { outcome: 'repeated'; invitation: InvitationView }
  | { outcome: 'account_exists' }
  | { outcome: 'invalid' };

/**
 * FR-AU-89 (a). `body` is the request's JSON, not yet looked at.
 *
 * In one transaction, and in the order of the contract page: the request
 * identifier is looked up first, so that a request sent twice changes nothing;
 * then the account; then whatever is pending for the address is closed and the
 * new invitation written.
 */
export async function createInvitation(body: unknown, now: Date = new Date()): Promise<CreateResult> {
  const { email: given, requestId } = (body ?? {}) as { email?: unknown; requestId?: unknown };
  if (typeof given !== 'string' || typeof requestId !== 'string') return { outcome: 'invalid' };
  const email = given.toLowerCase();
  if (email.length > 254 || !ADDRESS.test(email) || !REQUEST_ID.test(requestId))
    return { outcome: 'invalid' };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db().$transaction(async (tx): Promise<CreateResult> => {
        const before = await tx.admissionInvitation.findUnique({ where: { requestId }, select: VIEW });
        if (before) {
          return before.email === email
            ? { outcome: 'repeated', invitation: view(before, now) }
            : { outcome: 'invalid' };
        }
        if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
          return { outcome: 'account_exists' };
        }
        // A row still stored as pending is either past its expiry, and is now
        // written as expired, or open, and is revoked: its link creates nothing.
        await tx.admissionInvitation.updateMany({
          where: { email, state: 'PENDING', expiresAt: { lte: now } },
          data: { state: 'EXPIRED' },
        });
        await tx.admissionInvitation.updateMany({
          where: { email, state: 'PENDING' },
          data: { state: 'REVOKED', revokedAt: now },
        });
        const token = newToken();
        const row = await tx.admissionInvitation.create({
          data: {
            email,
            requestId,
            tokenHash: hashToken(token),
            createdAt: now,
            expiresAt: new Date(now.getTime() + settings().admissionInvitationDays * DAY_MS),
          },
          select: VIEW,
        });
        return { outcome: 'created', invitation: view(row, now), message: invitationEmail(email, token) };
      });
    } catch (error) {
      // Two requests at once, with one request identifier or for one address:
      // a unique index refused the second, which starts again and now finds
      // what the first wrote. Each attempt lost is another request's
      // invitation written, so a request loses at most as often as it has
      // rivals; past the bound it fails, and its caller sends it again.
      if (!isConflict(error) || attempt >= CREATE_ATTEMPTS - 1) throw error;
    }
  }
}

/** FR-AU-89 (b): every invitation, in one answer, oldest first. */
export async function listInvitations(now: Date = new Date()): Promise<InvitationView[]> {
  const rows = await db().admissionInvitation.findMany({ select: VIEW, orderBy: { createdAt: 'asc' } });
  return rows.map((row) => view(row, now));
}

export type RevokeResult =
  { outcome: 'revoked'; invitation: InvitationView } | { outcome: 'not_found' } | { outcome: 'not_pending' };

/**
 * FR-AU-89 (c): a pending invitation becomes revoked. One already revoked is
 * answered as revoked, so that a retry succeeds.
 */
export async function revokeInvitation(id: string, now: Date = new Date()): Promise<RevokeResult> {
  // One statement, conditional on the state: an acceptance at the same moment
  // either came first, and nothing is revoked, or finds the invitation closed.
  await db().admissionInvitation.updateMany({
    where: { id, state: 'PENDING', expiresAt: { gt: now } },
    data: { state: 'REVOKED', revokedAt: now },
  });
  const row = await db().admissionInvitation.findUnique({ where: { id }, select: VIEW });
  if (!row) return { outcome: 'not_found' };
  return row.state === 'REVOKED'
    ? { outcome: 'revoked', invitation: view(row, now) }
    : { outcome: 'not_pending' };
}

/**
 * The invited address of the pending invitation whose token this is, for the
 * sign-up page to show (FR-AU-90). Null for no token, and for the token of an
 * invitation that is accepted, revoked, or expired: the caller is told nothing
 * of which.
 */
export async function findOpenInvitation(
  token: string,
  now: Date = new Date(),
): Promise<{ email: string } | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const row = await db().admissionInvitation.findFirst({
    where: { tokenHash: hashToken(token), state: 'PENDING', expiresAt: { gt: now } },
    select: { email: true },
  });
  return row?.email ? { email: row.email } : null;
}

/**
 * FR-AU-90, the one transaction: the account, with the invited address
 * recorded as verified; the hash of its password; its personal workspace
 * (FR-AU-09); and the invitation marked accepted. All four, or none.
 *
 * Returns the new account, or null where the invitation is not open. The claim
 * comes first and is one conditional statement, so of two submissions of one
 * token the second waits for the first, then matches nothing and creates nothing.
 */
export async function acceptInvitation(
  input: { token: string; name: string; passwordHash: string },
  now: Date = new Date(),
): Promise<{ userId: string; email: string } | null> {
  if (!TOKEN.test(input.token)) return null;
  // FR-AU-04: issued here, once, and never changed or reused.
  const userId = randomUUID();
  try {
    return await db().$transaction(async (tx) => {
      const claimed = await tx.admissionInvitation.updateManyAndReturn({
        where: {
          tokenHash: hashToken(input.token),
          state: 'PENDING',
          expiresAt: { gt: now },
          email: { not: null },
        },
        data: { state: 'ACCEPTED', acceptedAt: now, acceptedById: userId },
        select: { email: true },
      });
      const email = claimed[0]?.email;
      if (claimed.length !== 1 || !email) return null;
      // The rows the identity library would write for an account with a
      // password (register D96): its endpoint for this is switched off.
      await tx.user.create({ data: { id: userId, name: input.name, email, emailVerified: true } });
      await tx.account.create({
        data: {
          id: randomUUID(),
          userId,
          providerId: 'credential',
          accountId: userId,
          password: input.passwordHash,
        },
      });
      await createPersonalWorkspace(tx, userId);
      return { userId, email };
    });
  } catch (error) {
    // The address gained an account after the invitation was created (an
    // account that changed its address to it). The transaction wrote nothing,
    // and the invitation is answered as not open.
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}
