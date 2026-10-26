// Creating, listing and renaming a document (FR-ED-35), and the rule of a
// title. Whether a caller may do any of it is not decided here: the routes ask
// ./access.ts first. Nothing here is of Next.js.
import type { Document } from '../../generated/prisma/client.ts';
import { AccountInDeletion, holdOwnableAccount } from '../account/in-deletion.ts';
import { db } from '../db.ts';
import { fieldText } from '../field-text.ts';
import { istorico } from '../istorico/index.ts';
import { ensurePersonalWorkspace } from '../workspace.ts';
import { COLLABORATOR_ROLE, defaultPermissionSet, holds } from './permissions.ts';

/** FR-ED-35, verbatim: the title a document has where none is given. */
export const DEFAULT_TITLE = 'Untitled document';
/** FR-ED-35: "a title of at most 200 characters". */
export const TITLE_MAX_CHARACTERS = 200;

/** What a route answers about a document, and what the list shows: nothing of its permission set, its Owner, or its workspace. */
export interface DocumentSummary {
  id: string;
  title: string;
  /** FR-ED-43: fixed at creation. `UNRECORDED` is shown as the mark "Not recorded". */
  recording: Document['recording'];
  createdAt: Date;
  updatedAt: Date;
}

export function summary({
  id,
  title,
  recording,
  createdAt,
  updatedAt,
}: Omit<Document, 'yjsState'>): DocumentSummary {
  return { id, title, recording, createdAt, updatedAt };
}

/**
 * The title to store for what a request gave, or why it is refused.
 *
 * FR-ED-35: "a title longer than 200 characters is refused, and an empty title
 * is stored as the default". The owner's decision of 8 October 2026, which
 * amends NFR-SE-08 for it: the white space at the two ends of a title is not
 * part of it, exactly as of the name of an account (FR-AU-90), by the one
 * function for both. Whether a title is empty, and how long it is, are judged
 * of what is left, a character being one Unicode code point. Nothing else is
 * removed (NFR-SE-08, NFR-I18-03): what is between the ends is stored as
 * written, and markup stays what was typed.
 *
 * Two things PostgreSQL cannot store as text are refused and not removed: the
 * character U+0000, and half of a surrogate pair.
 */
export function readTitle(
  value: unknown,
): { ok: true; title: string } | { ok: false; reason: 'not_text' | 'too_long' | 'not_storable' } {
  if (typeof value !== 'string') return { ok: false, reason: 'not_text' };
  if (value.includes('\u0000') || !value.isWellFormed()) return { ok: false, reason: 'not_storable' };
  const { text, characters } = fieldText(value);
  if (characters > TITLE_MAX_CHARACTERS) return { ok: false, reason: 'too_long' };
  return { ok: true, title: characters === 0 ? DEFAULT_TITLE : text };
}

/**
 * FR-ED-35: creates a document for this account, which is its Owner
 * (FR-ED-19), with the default title and the default permission set
 * (FR-ED-45).
 *
 * FR-AU-12: the workspace is the account's personal workspace, the only one
 * there is in α 0.1.0, "used without a selection step". It is looked up here
 * and taken from no caller, so a document cannot be put into a workspace that
 * is not its Owner's.
 *
 * It throws `AccountInDeletion` for an account whose deletion is confirmed
 * (FR-AU-58); a route answers that as it answers a request without a session.
 */
export async function createDocument(userId: string): Promise<DocumentSummary> {
  const personal = await ensurePersonalWorkspace(userId);

  // FR-ED-43, contract IC-16: recorded or unrecorded is fixed here, from the
  // capability the port reports and never from the adapter's name, and it is
  // read before the insert (the owner's answer to Q11 of the plan). With the
  // no-op adapter it is false, and every document is unrecorded.
  const port = istorico();
  const recording = port.capabilities().recording;

  const document = await db().$transaction(async (tx) => {
    // FR-AU-58: "no deleted account is ever the Owner of a document". The account's row is held
    // against the confirmation of its deletion, which counts the documents under the same row
    // (src/lib/account/in-deletion.ts): of a creation and a confirmation at once, one waits for the
    // other and reads what it left.
    if (!(await holdOwnableAccount(tx, userId))) throw new AccountInDeletion();
    return tx.document.create({
      data: {
        workspaceId: personal,
        ownerId: userId,
        title: DEFAULT_TITLE,
        permissionSet: defaultPermissionSet(),
        recording: recording ? 'RECORDED' : 'UNRECORDED',
        // An edit, the first: see `renameDocument`.
        updatedAt: new Date(),
      },
    });
  });

  // Contract IC-50, the extension point "Document creation": after the commit,
  // behind the capability. Not reached in α 0.1.0. Creation "never fails or
  // waits because Istorico is unavailable" (FR-ED-35), so the call is not
  // awaited. The port does not throw (IC-10), and the creation does not rest
  // on that: an adapter that throws or rejects all the same fails nothing
  // here. Nothing is logged of it (NFR-SE-19: an error could quote its input).
  // The outbox that repeats the call arrives with the release that links
  // Istorico (IC-27, IC-18).
  if (recording) {
    const input = {
      documentId: document.id,
      ownerUserId: userId,
      workspaceKind: 'personal' as const,
      workspaceId: personal,
      createdAt: document.createdAt.toISOString(),
    };
    void Promise.resolve()
      .then(() => port.registerDocument(input))
      .catch(() => {});
  }
  return summary(document);
}

/**
 * The documents of this account "across all workspaces" (API design,
 * "Documents"): those it is the Owner of, which in α 0.1.0 are all in its
 * personal workspace, and those it holds another role on through an accepted
 * invitation (FR-ED-19). A deleted document is in no list (FR-ED-36).
 *
 * The order is the owner's decision of 8 October 2026: the newest first, by
 * the time of creation, which is the date the list shows. Two documents of
 * one instant keep one order between them, by their identifiers.
 */
export async function listDocuments(userId: string): Promise<ListedDocument[]> {
  const documents = await db().document.findMany({
    where: { deletedAt: null, OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }] },
    include: { collaborators: { where: { userId }, select: { role: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return documents.map(({ collaborators, ...document }) => {
    const role = document.ownerId === userId ? 'owner' : COLLABORATOR_ROLE[collaborators[0]!.role];
    // What the list offers to this account: the routes decide again (FR-ED-39).
    return {
      ...summary(document),
      canRename: holds(document.permissionSet, role, 'document.rename') && document.clearingAt === null,
      canDelete: holds(document.permissionSet, role, 'document.delete') && document.clearingAt === null,
      clearingAt: document.clearingAt,
    };
  });
}

/** A row of the list: the summary, and which of its controls the account's role holds. */
export interface ListedDocument extends DocumentSummary {
  canRename: boolean;
  canDelete: boolean;
  /** FR-AU-91: the day a clearing deletes the document, or null. */
  clearingAt: Date | null;
}

/**
 * FR-ED-35: stores a title that `readTitle` has passed, for a document the
 * caller was authorised to rename; null where the document was deleted
 * between the authorisation and this write, and nothing was changed (FR-ED-36:
 * a restore returns the document as it was at deletion). The condition is in
 * the write, as it is in every write to a document.
 *
 * `updatedAt` is when a document was last edited, and the model does not move
 * it by itself (prisma/schema.prisma): the writes that are edits set it, and
 * they are three, this one, the creation above, and the store of the state
 * (src/lib/collab/state.ts). The deletion, the restore, and the claim of the
 * permanent deletion and its release are not edits, and do not name the column.
 */
export async function renameDocument(id: string, title: string): Promise<DocumentSummary | null> {
  const [renamed] = await db().document.updateManyAndReturn({
    // FR-AU-91: not a document in a clearing, whose title "no one can change" for the period.
    where: { id, deletedAt: null, clearingAt: null },
    data: { title, updatedAt: new Date() },
  });
  return renamed ? summary(renamed) : null;
}
