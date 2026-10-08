// Creating, listing and renaming a document (FR-ED-35), and the rule of a
// title. Whether a caller may do any of it is not decided here: the routes ask
// ./access.ts first. Nothing here is of Next.js.
import type { Document } from '../../generated/prisma/client.ts';
import { db } from '../db.ts';
import { istorico } from '../istorico/index.ts';
import { ensurePersonalWorkspace } from '../workspace.ts';
import { defaultPermissionSet } from './permissions.ts';

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
 * is stored as the default". NFR-SE-08, NFR-I18-03: a title is stored as
 * written, and no character is removed from it, so nothing is trimmed, and
 * markup stays what was typed. A character is one Unicode code point, as in
 * the name of an account (FR-AU-90). A title with nothing in it but white
 * space is taken as empty: it would name nothing on the screen.
 *
 * Two things PostgreSQL cannot store as text are refused and not removed: the
 * character U+0000, and half of a surrogate pair.
 */
export function readTitle(
  value: unknown,
): { ok: true; title: string } | { ok: false; reason: 'not_text' | 'too_long' | 'not_storable' } {
  if (typeof value !== 'string') return { ok: false, reason: 'not_text' };
  if (value.includes('\u0000') || !value.isWellFormed()) return { ok: false, reason: 'not_storable' };
  if ([...value].length > TITLE_MAX_CHARACTERS) return { ok: false, reason: 'too_long' };
  return { ok: true, title: value.trim() === '' ? DEFAULT_TITLE : value };
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
 */
export async function createDocument(userId: string): Promise<DocumentSummary> {
  const personal = await ensurePersonalWorkspace(userId);

  // FR-ED-43, contract IC-16: recorded or unrecorded is fixed here, from the
  // capability the port reports and never from the adapter's name, and it is
  // read before the insert (the owner's answer to Q11 of the plan). With the
  // no-op adapter it is false, and every document is unrecorded.
  const port = istorico();
  const recording = port.capabilities().recording;

  const document = await db().document.create({
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
 * personal workspace. The documents it holds another role on join with the
 * slice that builds sharing. A deleted document is in no list (FR-ED-36).
 *
 * The order is not given by the specification (reported as a gap): the newest
 * first, by the time of creation, which is the date the list shows.
 */
export async function listDocuments(userId: string): Promise<DocumentSummary[]> {
  const documents = await db().document.findMany({
    where: { ownerId: userId, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return documents.map(summary);
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
    where: { id, deletedAt: null },
    data: { title, updatedAt: new Date() },
  });
  return renamed ? summary(renamed) : null;
}
