// The Onboarding paper: the document every account is given once, a tutorial of the editor that is
// also an example of it. Its content is ProseMirror JSON (./onboarding-paper.json); this file turns it
// into the Yjs state the collaboration server loads (src/lib/collab/state.ts) and gives it to an
// account. tests/unit/onboarding-paper.test.ts holds the state to the editor's own binding and schema,
// and the text to what the owner approved.
//
// The state is built here, in plain Yjs, because the editor's schema is a client module that the
// server cannot import (src/lib/export/read.ts says the same). It is written as the editor's binding
// writes it: an element for every node, its attributes beside, and the text of a block, with its marks
// as formatting, in one run.
import * as Y from 'yjs';
import type { Prisma } from '../../generated/prisma/client.ts';
import { AccountInDeletion } from '../account/in-deletion.ts';
import { FRAGMENT_NAME } from '../collab/protocol.ts';
import { encodeState } from '../collab/state.ts';
import { db } from '../db.ts';
import { faultOf } from '../fault.ts';
import { istorico } from '../istorico/index.ts';
import { ensurePersonalWorkspace } from '../workspace.ts';
import { insertDocument, registerDocument } from './documents.ts';
import paper from './onboarding-paper.json' with { type: 'json' };

/** The title of the paper. Owner's decision, 22 November 2026. */
export const ONBOARDING_TITLE = 'Onboarding';

/** The same client for every copy, so that the bytes are the same on every run. Copies share nothing else. */
const CLIENT_ID = 1;

export interface PaperNode {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PaperNode[];
  text?: string;
}

/** The paper as ProseMirror JSON. */
export const onboardingPaper = paper as PaperNode;

type Child = Y.XmlElement | Y.XmlText;

function element(node: PaperNode): Y.XmlElement {
  const made = new Y.XmlElement(node.type);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (value !== null && value !== undefined) made.setAttribute(key, value as string);
  }
  const children: Child[] = [];
  // Consecutive text nodes are one run, each part with its own marks (an empty set names none).
  let run: Y.XmlText | undefined;
  let at = 0;
  for (const child of node.content ?? []) {
    if (child.type !== 'text') {
      run = undefined;
      children.push(element(child));
      continue;
    }
    if (!run) {
      run = new Y.XmlText();
      at = 0;
      children.push(run);
    }
    const marks: Record<string, unknown> = {};
    for (const mark of child.marks ?? []) marks[mark.type] = mark.attrs ?? {};
    const text = child.text ?? '';
    run.insert(at, text, marks);
    at += text.length;
  }
  if (children.length) made.insert(0, children);
  return made;
}

/** The state, built from the JSON each time it is called: what `onboardingState` caches, and what a test asks again. */
export function buildOnboardingState(): Uint8Array<ArrayBuffer> {
  const document = new Y.Doc();
  document.clientID = CLIENT_ID;
  const blocks = (onboardingPaper.content ?? []).map(element);
  document.getXmlFragment(FRAGMENT_NAME).insert(0, blocks);
  const state = encodeState(document);
  document.destroy();
  return state;
}

let built: Uint8Array<ArrayBuffer> | undefined;
/** The first content of the document, as the server stores it. Built once for the life of the process; each caller gets its own copy. */
export function onboardingState(): Uint8Array<ArrayBuffer> {
  built ??= buildOnboardingState();
  return built.slice();
}

/**
 * Gives the account its Onboarding paper, once. For every account, new or old: the owner's decision
 * of 22 November 2026. Called before the list of documents is read, by the page and by the route.
 *
 * The paper is the person's own ordinary document (FR-ED-35), made as any is, and it counts as one
 * (FR-AU-58). `User.onboardingPaperSeededAt` is claimed in the transaction that inserts it: of two
 * requests at once one waits for the other and finds the claim made; a failed insert undoes the
 * claim; and a paper the person deleted is not made again.
 *
 * It never throws. An account in deletion is given none (`insertDocument`). Any other fault leaves
 * the claim unmade, so the next list tries again, and is logged by its class alone (NFR-SE-19).
 */
export async function ensureOnboardingPaper(userId: string): Promise<void> {
  try {
    // The early exit of every list after the first: one read of the marker, before the workspace is
    // looked up or the state built. Only a shortcut: the claim below is what makes it once.
    const known = await db().user.findUnique({
      where: { id: userId },
      select: { onboardingPaperSeededAt: true },
    });
    if (!known || known.onboardingPaperSeededAt) return;
    const personal = await ensurePersonalWorkspace(userId);
    const recording = istorico().capabilities().recording;
    const state = onboardingState();
    const document = await db().$transaction(async (tx: Prisma.TransactionClient) => {
      // The claim first: it takes the row for update, as the confirmation of a deletion does, so the
      // hold in `insertDocument` cannot be upgraded against another request that holds it too.
      const { count } = await tx.user.updateMany({
        where: { id: userId, erasedAt: null, onboardingPaperSeededAt: null },
        data: { onboardingPaperSeededAt: new Date() },
      });
      if (count === 0) return null;
      return insertDocument(tx, { userId, workspaceId: personal, title: ONBOARDING_TITLE, recording, state });
    });
    if (document) registerDocument(document, userId, personal, recording);
  } catch (error) {
    if (error instanceof AccountInDeletion) return;
    console.error(`onboarding paper: not made (${faultOf(error)})`);
  }
}
