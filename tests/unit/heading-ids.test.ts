// The id each heading carries for the entries of a contents list (FR-ED-06): drawn at render time by
// a decoration, numbered as the list numbers the headings, and never part of the document.
import { getSchema } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { Decoration } from '@tiptap/pm/view';
import { prosemirrorToYDoc } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { closeSchema, extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { headingIds, headingsOf } from '../../src/app/(app)/documents/[id]/heading-ids.ts';
import { shapeOf } from '../../src/lib/collab/shape.ts';

const schema: Schema = closeSchema(getSchema(extensions(new Y.Doc())));
const plugin = headingIds();

type Json = Record<string, unknown>;
const heading = (text: string, level = 1): Json => ({
  type: 'heading',
  attrs: { level },
  content: text ? [{ type: 'text', text }] : [],
});
const paragraph = (text: string): Json => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const open = (...content: Json[]) =>
  EditorState.create({ schema, doc: schema.nodeFromJSON({ type: 'doc', content }), plugins: [plugin] });

/** What the editor draws: each decorated node's text, with the id it is given. */
function drawn(state: EditorState): [string, string][] {
  const set = plugin.props.decorations!.call(plugin, state)!;
  const found = (set as unknown as { find(): Decoration[] }).find();
  return found.map((each) => [
    state.doc.nodeAt(each.from)!.textContent,
    (each as unknown as { type: { attrs: { id: string } } }).type.attrs.id,
  ]);
}

describe('the id of a heading (FR-ED-06)', () => {
  it('is heading-N, N counting the headings with text from 1 in the order of the document, whatever the level', () => {
    const state = open(heading('A', 1), paragraph('x'), heading('B', 3), heading('', 2), heading('C', 2));
    expect(drawn(state)).toEqual([
      ['A', 'heading-1'],
      ['B', 'heading-2'],
      ['C', 'heading-3'],
    ]);
  });

  it('is the one the entry of the list links to: the list and the ids are read from the same headings', () => {
    const state = open(heading('A'), heading('B', 2), heading('  ', 2), heading('C', 3));
    expect(drawn(state)).toEqual(headingsOf(state.doc).map(({ text, id }) => [text, id]));
    expect(headingsOf(state.doc).map(({ id }) => id)).toEqual(['heading-1', 'heading-2', 'heading-3']);
  });

  it('is on every heading the list shows, one id each, none twice', () => {
    const state = open(...Array.from({ length: 40 }, (_, n) => heading(`H${n}`, 1 + (n % 3))));
    const ids = drawn(state).map(([, id]) => id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it('follows the headings when one is inserted above, removed, or moved, by this client or another', () => {
    let state = open(heading('A'), heading('B'), heading('C'));
    state = state.apply(state.tr.insert(0, schema.nodeFromJSON(heading('Zero'))));
    expect(drawn(state)).toEqual([
      ['Zero', 'heading-1'],
      ['A', 'heading-2'],
      ['B', 'heading-3'],
      ['C', 'heading-4'],
    ]);
    // Removed: the first of the document.
    state = state.apply(state.tr.delete(0, state.doc.child(0).nodeSize));
    expect(drawn(state).map(([, id]) => id)).toEqual(['heading-1', 'heading-2', 'heading-3']);
    // Moved: C to the top, which is how a reordering from another client arrives (the whole document is replaced).
    const moved = schema.nodeFromJSON({ type: 'doc', content: [heading('C'), heading('A'), heading('B')] });
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, moved.content));
    expect(drawn(state)).toEqual([
      ['C', 'heading-1'],
      ['A', 'heading-2'],
      ['B', 'heading-3'],
    ]);
    // A heading that gets its first word is numbered from then on.
    state = state.apply(state.tr.insert(0, schema.nodeFromJSON(heading(''))));
    expect(drawn(state).map(([, id]) => id)).toEqual(['heading-1', 'heading-2', 'heading-3']);
    state = state.apply(state.tr.insertText('New', 1));
    expect(drawn(state)).toEqual([
      ['New', 'heading-1'],
      ['C', 'heading-2'],
      ['A', 'heading-3'],
      ['B', 'heading-4'],
    ]);
  });

  it('is not part of the document: not an attribute, not in its JSON, not in the Yjs update, and the shape check passes it', () => {
    const state = open(heading('A'), heading('B', 2), paragraph('x'));
    expect(Object.keys(schema.nodes.heading!.spec.attrs ?? {})).toEqual(['level']);
    const nodes: PMNode[] = [];
    state.doc.descendants((each) => void nodes.push(each));
    expect(nodes.every((each) => !('id' in each.attrs))).toBe(true);
    expect(JSON.stringify(state.doc.toJSON())).not.toMatch(/heading-\d|"id"/);

    const update = Y.encodeStateAsUpdate(prosemirrorToYDoc(state.doc, 'default'));
    expect(Buffer.from(update).toString('latin1')).not.toContain('heading-');
    expect(shapeOf(new Y.Doc(), update)).toBeNull();
  });
});
