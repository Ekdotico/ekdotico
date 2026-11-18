// The transfer of all documents (FR-AU-92): the plan, the action, and what the deletion screen shows of it.
// The offers themselves are FR-ED-47's and are made, answered, withdrawn and expired by src/lib/documents/
// ownership.ts; this module decides, for each document the account owns, whether an offer is made and to whom,
// and makes them all in one transaction. The email of the offers is ./transfer-email.ts.
//
// Nothing here is of Next.js, and nothing here asks for a password: FR-AU-58 asks for it at the confirmation of
// the deletion and of a clearing, and the API design page gives this route the auth `A` alone.
//
// THE ROWS DECIDE AND THE REQUEST NAMES. The request names the way the new Owner is chosen and the identifiers of
// the documents the user confirmed. They are compared, as sets, with the documents this account would be offering
// ownership of now, read under the locks of their rows (a pending offer that stays is one of them). A request that
// names one more, one fewer, or one that is not the account's offers nothing (a 409). The offers are those the rows
// say, and no identifier of the request is ever the document an offer is made for.
//
// THE LOCKS, in the order of slices 22 and 23: the session's row, every document the account owns (in the order of
// the identifiers, whatever its state), then the accounts of the people who may be offered a document (in the
// order of their identifiers), `FOR SHARE`. A change of role, a removal, an invitation accepted, a deletion, a
// restore, an offer and its acceptance take the document's row, so with it held they are one after the other. The
// recipient's account held `FOR SHARE` makes the confirmation of the recipient's deletion (`FOR UPDATE`) wait for
// this action or find it: either an offer is made to the account and the step of its deletion declines it, or no
// offer is made to an account in deletion (FR-AU-58 (a), (f)).
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.ts';
import { holdSession, type ValidSession } from '../auth/session.ts';
import { displayNameOf } from '../collab/presence.ts';
import { db } from '../db.ts';
import { createOffer, settleMany, transferable, type Tx } from '../documents/ownership.ts';
import { guardRefusal, guardSpend, type Guard, type GuardRefusal } from './guard.ts';
import { takeLimitReturnable } from '../rate-limit.ts';
import { settings } from '../settings.ts';
import { DELETED_ACCOUNT } from './deleted-account.ts';
import { inDeletion } from './in-deletion.ts';

/** The most documents one transfer names, as a clearing (docs/plan/slice-23.md, S23-7). */
export const TRANSFER_MOST_DOCUMENTS = 6000;

/** What the identifier of a collaborator's row looks like (a cuid); anything else names nothing and is not looked up. */
export const COLLABORATOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** FR-AU-92: "To the longest-standing Editor", or "To one person". */
export type Choice = { mode: 'longest' } | { mode: 'person'; userId: string };

/** What the plan needs to know of one document the account owns. */
export interface PlanDocument {
  id: string;
  deleted: boolean;
  /** Claimed by the timer for its permanent deletion. */
  claimed: boolean;
  /** The day of the deletion of a document in a clearing (S23-2: the time of the confirmation, for one that is not shared). */
  clearingAt: Date | null;
  transferable: boolean;
  /** The offer that is open now: stored pending, and its time ahead. */
  pending: { toUserId: string } | null;
  /** The Editors who may be offered it: the role is Editor, there is an address, and the account is not in deletion. */
  editors: { userId: string; roleSince: Date; addedAt: Date }[];
  /** The Editors to whom this Owner offered this document and who declined it or let the offer expire. */
  passedOver: ReadonlySet<string>;
}

export type SkipReason =
  'deleted' | 'being_deleted' | 'not_transferable' | 'no_editor' | 'no_other_editor' | 'not_their_editor';

export type Outcome =
  | { kind: 'offer'; toUserId: string }
  /** FR-AU-92: "A document that already has a pending offer keeps it and is counted as offered." */
  | { kind: 'keep' }
  | { kind: 'skip'; reason: SkipReason };

/**
 * FR-AU-92 (a): the Editor "who has held the Editor role on it for the longest unbroken time up to that moment,
 * counted from the time the collaborator's current role was granted"; "where two have held it equally long, the one
 * whose collaboration on the document began first, and then the one whose user identifier sorts first".
 */
export function longestStanding(
  editors: readonly { userId: string; roleSince: Date; addedAt: Date }[],
): string | null {
  const sorted = [...editors].sort(
    (a, b) =>
      a.roleSince.getTime() - b.roleSince.getTime() ||
      a.addedAt.getTime() - b.addedAt.getTime() ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
  return sorted[0]?.userId ?? null;
}

/**
 * The plan: for each document, whether an offer is made, to whom, or why not. One function for the screen (from a
 * read without locks) and for the transaction (from a read under them), so that they cannot differ in the rule.
 * The order of the checks is the order of the statements of FR-AU-92, FR-AU-91 and FR-ED-47.
 */
export function planTransfer(
  documents: readonly PlanDocument[],
  choice: Choice,
  now: Date,
): Map<string, Outcome> {
  const plan = new Map<string, Outcome>();
  for (const document of documents) {
    let outcome: Outcome;
    if (document.clearingAt && (document.clearingAt <= now || document.claimed)) {
      // FR-AU-91: after the day "no offer may be made": the document is the timer's.
      outcome = { kind: 'skip', reason: 'being_deleted' };
    } else if (document.deleted) {
      // FR-AU-92: "A document that is deleted and within its retention is not offered".
      outcome = { kind: 'skip', reason: 'deleted' };
    } else if (!document.transferable) {
      outcome = { kind: 'skip', reason: 'not_transferable' };
    } else if (document.pending) {
      outcome = { kind: 'keep' };
    } else if (choice.mode === 'person') {
      outcome = document.editors.some(({ userId }) => userId === choice.userId)
        ? { kind: 'offer', toUserId: choice.userId }
        : { kind: 'skip', reason: 'not_their_editor' };
    } else {
      const toUserId = longestStanding(
        document.editors.filter(({ userId }) => !document.passedOver.has(userId)),
      );
      outcome = toUserId
        ? { kind: 'offer', toUserId }
        : { kind: 'skip', reason: document.editors.length === 0 ? 'no_editor' : 'no_other_editor' };
    }
    plan.set(document.id, outcome);
  }
  return plan;
}

/**
 * How many offers of the limit of an hour (NFR-SE-07, D219) an action that makes these new offers uses: the one rule,
 * in one place. One for each person it emails, and not one for each document (FR-AU-92; the owner's answer to S24-1,
 * register D268): forty documents offered to one person count one. An offer made on its own counts one. The people
 * are those of the new offers, which are the ones that are emailed: a kept offer sends nothing and counts nothing.
 */
export const offersCounted = (fresh: readonly { toUserId: string }[]): number =>
  new Set(fresh.map(({ toUserId }) => toUserId)).size;

/** The documents the plan offers or keeps, which the confirmation counts as offered, in the order of the identifiers. */
export function offeredIds(plan: ReadonlyMap<string, Outcome>): string[] {
  return [...plan]
    .filter(([, outcome]) => outcome.kind !== 'skip')
    .map(([id]) => id)
    .sort();
}

// ── Reading ─────────────────────────────────────────────────────────────────

const owned = (userId: string) =>
  ({
    where: { ownerId: userId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      title: true,
      deletedAt: true,
      deletionClaimedAt: true,
      clearingAt: true,
      recording: true,
      workspace: { select: { type: true } },
      collaborators: {
        where: { role: 'EDITOR' },
        orderBy: { id: 'asc' },
        select: { id: true, userId: true, roleSince: true, addedAt: true, user: { select: { email: true } } },
      },
      offers: {
        where: { fromUserId: userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          state: true,
          toUserId: true,
          expiresAt: true,
          to: { select: { name: true, email: true } },
        },
      },
    },
  }) satisfies Prisma.DocumentFindManyArgs;

type OwnedRow = Prisma.DocumentGetPayload<ReturnType<typeof owned>>;

/** The accounts that can be offered a document: they exist, are not erased, and their deletion is not confirmed. */
async function eligibleAccounts(
  client: Pick<Tx, 'user' | 'accountDeletion'>,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [present, leaving] = await Promise.all([
    client.user.findMany({ where: { id: { in: ids }, erasedAt: null }, select: { id: true } }),
    client.accountDeletion.findMany({ where: { userId: { in: ids } }, select: { userId: true } }),
  ]);
  const gone = new Set(leaving.map(({ userId }) => userId));
  return new Set(present.map(({ id }) => id).filter((id) => !gone.has(id)));
}

/** Whether an offer is over without being answered: stored expired, or stored pending with its time past. */
const lapsed = (offer: { state: string; expiresAt: Date }, now: Date) =>
  offer.state === 'EXPIRED' || (offer.state === 'PENDING' && offer.expiresAt <= now);

function planOf(row: OwnedRow, eligible: ReadonlySet<string>, now: Date): PlanDocument {
  const pending = row.offers.find(({ state, expiresAt }) => state === 'PENDING' && expiresAt > now);
  return {
    id: row.id,
    deleted: row.deletedAt !== null,
    claimed: row.deletionClaimedAt !== null,
    clearingAt: row.clearingAt,
    transferable: transferable(row),
    pending: pending ? { toUserId: pending.toUserId } : null,
    editors: row.collaborators
      .filter(({ userId, user }) => user.email && eligible.has(userId))
      .map(({ userId, roleSince, addedAt }) => ({ userId, roleSince, addedAt })),
    passedOver: new Set(
      row.offers
        .filter((offer) => offer.state === 'DECLINED' || lapsed(offer, now))
        .map(({ toUserId }) => toUserId),
    ),
  };
}

// ── The action ──────────────────────────────────────────────────────────────

export type TransferRequest =
  | { mode: 'longest'; documentIds: readonly string[] }
  | { mode: 'person'; collaboratorId: string; documentIds: readonly string[] };

export type TransferResult =
  | {
      outcome: 'offered';
      batchId: string;
      /** New offers made. */
      offered: number;
      /** Documents that already had an offer, which stands. */
      kept: number;
      /** Documents this action does not offer. */
      cannot: number;
      /** The people offered, with the number of documents offered to each by this action. */
      recipients: { userId: string; count: number }[];
    }
  /** The session ended since the request was authorised (FR-AU-84): nothing was done. */
  | { outcome: 'ended' }
  /** There is no such account, or its deletion is confirmed: it offers nothing. */
  | { outcome: 'not_found' }
  /** FR-AU-92: the identifiers are not exactly the documents that would be offered now. Nothing was done. */
  | { outcome: 'changed' }
  | { outcome: 'nothing' }
  /** "To one person": the row is not an Editor's row on a document of this account. */
  | { outcome: 'no_such_person' }
  /** NFR-SE-07, D268: more people to email than the limit of offers allows in any hour, whatever the hour. */
  | { outcome: 'over_limit'; most: number; wanted: number }
  /** NFR-SE-07: the allowance of this hour does not cover the people to email. */
  | { outcome: 'rate_limited'; retryAfterSeconds: number }
  /** FR-AU-92, D285: the password or session of the prompt no longer stands, or the recovery code is spent. */
  | GuardRefusal;

/** The same sets, each name once. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return (
    left.size === a.length &&
    right.size === b.length &&
    left.size === right.size &&
    [...left].every((id) => right.has(id))
  );
}

/**
 * FR-AU-92, in one transaction (the locks in the head of this file): the plan is made from the rows as they stand
 * under the locks, compared with what was confirmed, and every offer is made, with its notification, or none.
 */
export async function confirmTransfer(
  session: ValidSession,
  request: TransferRequest,
  given: Date | undefined,
  guard: Guard,
): Promise<TransferResult> {
  const userId = session.userId;
  // NFR-SE-07: counted in the transaction, after every refusal, and given back where it then fails.
  let giveBack: (() => Promise<void>) | undefined;
  try {
    return await db().$transaction(async (tx): Promise<TransferResult> => {
      if (!(await holdSession(tx, session))) return { outcome: 'ended' };
      // FR-AU-92, D285: the password asked for before the action still stands.
      const outrun = await guardRefusal(tx, guard);
      if (outrun) return outrun;
      // The documents of the account, in every state, in the order of their identifiers.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ekdotico"."Document" WHERE "ownerId" = ${userId} ORDER BY "id" FOR UPDATE`;
      const ids = locked.map(({ id }) => id);
      // An account whose deletion is confirmed makes no offer (FR-AU-58 (a)). It owns no document (the
      // confirmation counts them under the account's row), so this is the backstop of that rule.
      if (await inDeletion(userId, tx)) return { outcome: 'not_found' };

      // The accounts that may be offered a document: the Editors of these documents, held `FOR SHARE` until the
      // commit and then asked for their deletion.
      const candidates = (
        await tx.documentCollaborator.findMany({
          where: { documentId: { in: ids }, role: 'EDITOR' },
          select: { userId: true },
          distinct: ['userId'],
        })
      )
        .map(({ userId: id }) => id)
        .sort();
      if (candidates.length > 0) {
        await tx.$queryRaw`
          SELECT "id" FROM "ekdotico"."User" WHERE "id" = ANY(${candidates}::text[]) ORDER BY "id" FOR SHARE`;
      }
      // The time is read here, after every wait for a lock, and not when the request began: the day of a clearing
      // or the end of an offer that came while this waited is the day it is judged by (as `answerOffer` does).
      const now = given ?? new Date();
      // The offers whose time has passed, or whose Editor has lost the role, are written as they are, under the locks.
      await settleMany(tx, ids, now);
      const rows = await tx.document.findMany({
        ...owned(userId),
        where: { id: { in: ids }, ownerId: userId },
      });
      const eligible = await eligibleAccounts(tx, candidates);

      let choice: Choice;
      if (request.mode === 'person') {
        const row = COLLABORATOR_ID.test(request.collaboratorId)
          ? await tx.documentCollaborator.findFirst({
              where: { id: request.collaboratorId, role: 'EDITOR', documentId: { in: ids } },
              select: { userId: true },
            })
          : null;
        if (!row || !eligible.has(row.userId)) return { outcome: 'no_such_person' };
        choice = { mode: 'person', userId: row.userId };
      } else {
        choice = { mode: 'longest' };
      }

      const plan = planTransfer(
        rows.map((row) => planOf(row, eligible, now)),
        choice,
        now,
      );
      const offered = offeredIds(plan);
      if (!sameSet(offered, request.documentIds)) return { outcome: 'changed' };
      if (offered.length === 0) return { outcome: 'nothing' };
      const fresh = [...plan].flatMap(([documentId, outcome]) =>
        outcome.kind === 'offer' ? [{ documentId, toUserId: outcome.toUserId }] : [],
      );
      if (fresh.length > 0) {
        const most = settings().limits.OFFERS_PER_USER.max;
        const wanted = offersCounted(fresh);
        if (wanted > most) return { outcome: 'over_limit', most, wanted };
        const limit = await takeLimitReturnable('OFFERS_PER_USER', userId, wanted);
        if (!limit.ok) return { outcome: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
        giveBack = limit.giveBack;
      }
      // Every refusal of the action, the limit included, is behind us: a recovery code is spent only by a transfer
      // that is made (review of PR 80, item 1). Where it was spent already, the count is given back.
      const gone = await guardSpend(tx, guard);
      if (gone) {
        await giveBack?.();
        giveBack = undefined;
        return gone;
      }

      const batchId = randomUUID();
      const counts = new Map<string, number>();
      for (const { documentId, toUserId } of fresh) {
        await createOffer(tx, { documentId, fromUserId: userId, toUserId, now, batchId });
        counts.set(toUserId, (counts.get(toUserId) ?? 0) + 1);
      }
      return {
        outcome: 'offered',
        batchId,
        offered: fresh.length,
        kept: offered.length - fresh.length,
        cannot: rows.length - offered.length,
        recipients: [...counts].map(([recipient, count]) => ({ userId: recipient, count })),
      };
    });
  } catch (error) {
    await giveBack?.().catch((fault: unknown) =>
      console.error(
        `transfer offers: count not given back (${(fault as { name?: string } | null)?.name ?? 'fault'})`,
      ),
    );
    // The index of one pending offer for a document, were the locks ever not enough.
    if ((error as { code?: unknown } | null)?.code === 'P2002') return { outcome: 'changed' };
    throw error;
  }
}

// ── What the deletion screen shows ──────────────────────────────────────────

export type DocumentState =
  | { kind: 'offered'; toName: string; expiresAt: Date }
  | { kind: 'declined'; toName: string }
  | { kind: 'expired'; toName: string }
  | { kind: 'no_editor' }
  | { kind: 'no_other_editor' }
  | { kind: 'ready' }
  | { kind: 'deleted' }
  | { kind: 'being_deleted' }
  | { kind: 'not_transferable' };

export interface ScreenDocument {
  id: string;
  title: string;
  state: DocumentState;
}

/**
 * What the confirmation names for a choice. `documentIds` are the documents it would offer or keep, which the request
 * names; `offered` is the number of new offers it would make for this choice, `kept` the number of documents that
 * already have an offer, which stands whoever it is made to, and `cannot` the rest.
 */
export interface Counted {
  documentIds: string[];
  offered: number;
  kept: number;
  cannot: number;
}

export interface TransferScreen {
  /** Every document the account owns, with its state, in the order of the identifiers. */
  documents: ScreenDocument[];
  /** FR-AU-92: documents of an earlier transfer of all documents that were accepted, while the account holds a role on them (S24-6). */
  accepted: { id: string; title: string; toName: string }[];
  longest: Counted;
  /** The Editors of the account's documents, each by one of their rows (the account's identifier is not sent). */
  people: (Counted & { collaboratorId: string; name: string })[];
}

const nameOf = (account: { name: string | null; email: string | null }) =>
  account.email ? displayNameOf(account) : DELETED_ACCOUNT;

function stateOf(row: OwnedRow, document: PlanDocument, outcome: Outcome, now: Date): DocumentState {
  if (outcome.kind === 'keep') {
    const offer = row.offers.find(({ state, expiresAt }) => state === 'PENDING' && expiresAt > now)!;
    return { kind: 'offered', toName: nameOf(offer.to), expiresAt: offer.expiresAt };
  }
  if (outcome.kind === 'skip') {
    switch (outcome.reason) {
      case 'being_deleted':
        return { kind: 'being_deleted' };
      case 'deleted':
        return { kind: 'deleted' };
      case 'not_transferable':
        return { kind: 'not_transferable' };
      case 'no_editor':
        return { kind: 'no_editor' };
      case 'no_other_editor':
        // Every Editor has been offered it and declined or let it lapse (or the offer was withdrawn since): there is
        // no next Editor by the rule of (a), whatever the last offer says.
        return { kind: 'no_other_editor' };
    }
  }
  // Free to be offered, or left with a next Editor by a decline or an expiry: the last offer says which.
  const last = row.offers[0];
  if (document.editors.length === 0) return { kind: 'no_editor' };
  if (last?.state === 'DECLINED') return { kind: 'declined', toName: nameOf(last.to) };
  if (last && lapsed(last, now)) return { kind: 'expired', toName: nameOf(last.to) };
  return { kind: 'ready' };
}

/**
 * FR-AU-58, FR-AU-92: what the deletion screen shows of the documents the account owns and of the transfer, read
 * without locks. The transaction of the action reads again under them; this is what the user was shown.
 */
export async function transferScreen(userId: string, now: Date = new Date()): Promise<TransferScreen> {
  const rows = await db().document.findMany(owned(userId));
  const candidates = [
    ...new Set(rows.flatMap(({ collaborators }) => collaborators.map(({ userId: id }) => id))),
  ];
  const eligible = await eligibleAccounts(db(), candidates);
  const documents = rows.map((row) => planOf(row, eligible, now));

  const longest = planTransfer(documents, { mode: 'longest' }, now);
  const count = (plan: ReadonlyMap<string, Outcome>): Counted => {
    const documentIds = offeredIds(plan);
    const offered = [...plan.values()].filter(({ kind }) => kind === 'offer').length;
    return {
      documentIds,
      offered,
      kept: documentIds.length - offered,
      cannot: rows.length - documentIds.length,
    };
  };

  // Every Editor of the account's documents, by the first of their rows (the account's identifier is not sent).
  const row = new Map<string, { collaboratorId: string; name: string; userId: string }>();
  for (const { collaborators } of rows) {
    for (const { id, userId: editor, user } of collaborators) {
      if (user.email && eligible.has(editor) && !row.has(editor)) {
        row.set(editor, { collaboratorId: id, name: '', userId: editor });
      }
    }
  }
  const names = await db().user.findMany({
    where: { id: { in: [...row.keys()] } },
    select: { id: true, name: true, email: true },
  });
  for (const account of names) row.get(account.id)!.name = nameOf(account);
  const people = [...row.values()].flatMap((person) => {
    const plan = planTransfer(documents, { mode: 'person', userId: person.userId }, now);
    // Only a person to whom this action would make a new offer is one to pick.
    if (![...plan.values()].some(({ kind }) => kind === 'offer')) return [];
    return [{ collaboratorId: person.collaboratorId, name: person.name, ...count(plan) }];
  });
  people.sort(
    (a, b) => a.name.localeCompare(b.name, 'en-GB') || (a.collaboratorId < b.collaboratorId ? -1 : 1),
  );

  const accepted = await db().ownershipOffer.findMany({
    where: {
      fromUserId: userId,
      state: 'ACCEPTED',
      batchId: { not: null },
      document: { ownerId: { not: userId }, deletedAt: null, collaborators: { some: { userId } } },
    },
    orderBy: [{ respondedAt: 'desc' }, { id: 'desc' }],
    select: { document: { select: { id: true, title: true } }, to: { select: { name: true, email: true } } },
  });

  return {
    documents: rows.map((r, index) => ({
      id: r.id,
      title: r.title,
      state: stateOf(r, documents[index]!, longest.get(r.id)!, now),
    })),
    accepted: accepted.map(({ document, to }) => ({
      id: document.id,
      title: document.title,
      toName: nameOf(to),
    })),
    longest: count(longest),
    people,
  };
}
