// NFR-IC-14, NFR-PE-01 (procedure 1): the reference document is 5,000 words of headings and paragraphs, with no
// citation, no LaTeX block and no Mermaid block, a document the editor's schema takes, and always the same one.
import { readFileSync } from 'node:fs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { closeSchema, extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { MAX_STATE_BYTES, elementDepth, encodeState } from '../../src/lib/collab/state.ts';
import { countWords, referenceDocument, WORDS } from '../fixtures/reference-document.ts';

const committed = JSON.parse(readFileSync('tests/fixtures/reference-document.json', 'utf8'));
const schema = closeSchema(getSchema(extensions(new Y.Doc())));

describe('the reference document', () => {
  it('is the committed fixture, made by the generator and by nothing else', () => {
    expect(committed).toEqual(referenceDocument());
    expect(referenceDocument()).toEqual(referenceDocument());
  });

  it('has 5,000 words, counting the headings', () => {
    expect(WORDS).toBe(5000);
    expect(countWords(committed)).toBe(5000);
  });

  it('holds headings and paragraphs of plain text, and no block of a citation, a formula or a diagram', () => {
    const kinds = new Set<string>();
    const walk = (node: { type: string; marks?: unknown[]; content?: unknown[] }) => {
      kinds.add(node.type);
      expect(node.marks ?? [], node.type).toEqual([]);
      (node.content ?? []).forEach((child) => walk(child as never));
    };
    walk(committed);
    expect([...kinds].sort()).toEqual(['doc', 'heading', 'paragraph', 'text']);
    for (const block of committed.content) {
      expect(block.content?.[0]?.text?.length, block.type).toBeGreaterThan(5);
      if (block.type === 'heading') expect([1, 2]).toContain(block.attrs.level);
    }
    expect(
      committed.content.filter((block: { type: string }) => block.type === 'paragraph').length,
    ).toBeGreaterThan(40);
  });

  it('is a document of the editor: the schema takes it, and it is far inside the limits of a document', () => {
    schema.nodeFromJSON(committed).check();
    const document = prosemirrorJSONToYDoc(schema, committed, 'default');
    expect(encodeState(document).length).toBeLessThan(MAX_STATE_BYTES / 10);
    expect(elementDepth(document)).toBeLessThan(5);
  });
});
