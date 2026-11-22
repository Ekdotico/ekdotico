// The Onboarding paper (src/lib/documents/onboarding-paper.ts): its state is what the editor's own
// binding writes for its JSON, the JSON is a document the editor's schema takes and the server's limits
// allow, it exports as Markdown, and its text is the text the owner approved.
import { Node } from '@tiptap/pm/model';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { FRAGMENT_NAME } from '../../src/lib/collab/protocol.ts';
import { MAX_ELEMENT_DEPTH, MAX_STATE_BYTES, applyState, elementDepth } from '../../src/lib/collab/state.ts';
import {
  ONBOARDING_TITLE,
  onboardingPaper,
  onboardingState,
} from '../../src/lib/documents/onboarding-paper.ts';
import { readTitle } from '../../src/lib/documents/documents.ts';
import { editorSchema, editorState, fileOf } from './export-fixtures.ts';

const rootOf = (state: Uint8Array) => {
  const document = new Y.Doc();
  applyState(document, state);
  return yXmlFragmentToProseMirrorRootNode(document.getXmlFragment(FRAGMENT_NAME), editorSchema());
};

/** Every text of the paper, in order, one line for each block that holds text. */
function textsOf(node: Node): string[] {
  const out: string[] = [];
  node.descendants((each) => {
    if (each.isTextblock) out.push(each.textContent);
  });
  return out;
}

describe('the Onboarding paper', () => {
  it('is titled Onboarding, a title the document rule takes whole', () => {
    expect(ONBOARDING_TITLE).toBe('Onboarding');
    expect(readTitle(ONBOARDING_TITLE)).toEqual({ ok: true, title: 'Onboarding' });
  });

  it('is a document the editor schema takes, in every node and mark', () => {
    expect(() => Node.fromJSON(editorSchema(), onboardingPaper).check()).not.toThrow();
  });

  it('is the state the editor binding writes for it', () => {
    const ours = rootOf(onboardingState());
    const editors = rootOf(editorState(onboardingPaper));
    expect(ours.eq(editors)).toBe(true);
    expect(ours.eq(Node.fromJSON(editorSchema(), onboardingPaper))).toBe(true);
  });

  it('is the same bytes on every run, and a state that loads', () => {
    expect(Buffer.from(onboardingState()).equals(Buffer.from(onboardingState()))).toBe(true);
    const document = new Y.Doc();
    expect(() => applyState(document, onboardingState())).not.toThrow();
  });

  it('is within the limits of a document', () => {
    const state = onboardingState();
    expect(state.byteLength).toBeLessThan(MAX_STATE_BYTES / 100);
    const document = new Y.Doc();
    applyState(document, state);
    expect(elementDepth(document)).toBeLessThan(MAX_ELEMENT_DEPTH);
  });

  it('holds no image, so no stored object is needed', () => {
    let images = 0;
    Node.fromJSON(editorSchema(), onboardingPaper).descendants((node) => {
      if (node.type.name === 'image') images += 1;
    });
    expect(images).toBe(0);
  });

  it('exports as Markdown, with its table, its list and its footnote', () => {
    const file = fileOf(onboardingState(), { title: ONBOARDING_TITLE });
    expect(file).toContain('Welcome to Ekdotico α');
    expect(file).toContain('| Action | Shortcut | Effect on selected text |');
    expect(file).toContain('Footnotes are numbered in the order their markers appear.');
  });

  // PROVISIONAL: the text below is the draft, not approved. When the owner approves a final text, the
  // JSON is replaced and this list is replaced with the whole approved text, word for word.
  it('has the text of the draft (not yet approved)', () => {
    const texts = textsOf(rootOf(onboardingState()));
    expect(texts[0]).toBe('Welcome to Ekdotico α');
    expect(texts.at(-1)).toBe('Footnotes are numbered in the order their markers appear.');
    expect(texts).toHaveLength(textsOf(Node.fromJSON(editorSchema(), onboardingPaper)).length);
  });
});
