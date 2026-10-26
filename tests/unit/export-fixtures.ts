// Documents for the tests of the Markdown draft export, made two ways: by hand in Yjs (to say exactly what a stored
// state holds, hostile values included), and from ProseMirror JSON through the editor's own schema and binding
// (to say what an editor writes). The first never passes through the editor's rules, which is the point.
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { closeSchema, extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { FRAGMENT_NAME } from '../../src/lib/collab/protocol.ts';
import { renderMarkdown } from '../../src/lib/export/markdown.ts';
import { imageIdsOf, readDocument } from '../../src/lib/export/read.ts';

export const NOW = new Date(Date.UTC(2026, 9, 26, 13, 45, 30));
export const DOCUMENT_ID = '0b9f1c2e-7d34-4a56-8e01-23456789abcd';

type Child = Y.XmlElement | Y.XmlText;
type Attributes = Record<string, unknown>;

/** An element of a stored document, with the attributes it is given and no rule held to them. */
export function el(name: string, attributes: Attributes = {}, ...children: Child[]): Y.XmlElement {
  const element = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value as string);
  if (children.length) element.insert(0, children);
  return element;
}

/** A run of text, with the marks as the binding writes them: `{ bold: {}, link: { href } }`. */
export function tx(text: string, marks?: Attributes): Y.XmlText {
  const run = new Y.XmlText();
  run.insert(0, text, marks);
  return run;
}

export const p = (...content: (Child | string)[]) =>
  el('paragraph', {}, ...content.map((each) => (typeof each === 'string' ? tx(each) : each)));
export const heading = (level: unknown, text: string) => el('heading', { level }, tx(text));
export const note = (id: unknown) => el('footnoteReference', { id });
export const entry = (id: unknown, ...content: (Child | string)[]) =>
  el('footnote', { id }, ...content.map((each) => (typeof each === 'string' ? tx(each) : each)));
export const notes = (...entries: Y.XmlElement[]) => el('footnotes', {}, ...entries);
export const br = () => el('hardBreak');
export const image = (attributes: Attributes) => el('image', attributes);
export const item = (...blocks: Y.XmlElement[]) => el('listItem', {}, ...blocks);
export const bullets = (...items: Y.XmlElement[]) => el('bulletList', {}, ...items);
export const ordered = (start: unknown, ...items: Y.XmlElement[]) => el('orderedList', { start }, ...items);
export const cell = (attributes: Attributes, ...blocks: Y.XmlElement[]) =>
  el('tableCell', attributes, ...(blocks.length ? blocks : [p()]));
export const headerCell = (attributes: Attributes, ...blocks: Y.XmlElement[]) =>
  el('tableHeader', attributes, ...(blocks.length ? blocks : [p()]));
export const row = (...cells: Y.XmlElement[]) => el('tableRow', {}, ...cells);
export const table = (caption: string, ...rows: Y.XmlElement[]) =>
  el('tableBlock', {}, el('table', {}, ...rows), el('tableCaption', {}, ...(caption ? [tx(caption)] : [])));

/** The state a client would have stored for these blocks at the root. */
export function stateOf(...blocks: Child[]): Uint8Array {
  const document = new Y.Doc();
  document.getXmlFragment(FRAGMENT_NAME).insert(0, blocks);
  return Y.encodeStateAsUpdate(document);
}

let schema: ReturnType<typeof closeSchema> | undefined;
/** The editor's own schema, with its rules, for the tests that write a document as the editor does. */
export const editorSchema = () => (schema ??= closeSchema(getSchema(extensions(new Y.Doc()))));

/** The state the editor's binding writes for a ProseMirror document given as JSON. */
export function editorState(json: unknown): Uint8Array {
  return Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(editorSchema(), json as object, FRAGMENT_NAME));
}

/** The whole file for a stored state: the images are the identifiers given, in order, written as `images/NNN.png`. */
export function fileOf(
  state: Uint8Array | null,
  options: { title?: string; available?: readonly string[]; now?: Date } = {},
): string {
  const document = readDocument(state);
  const available = options.available ?? imageIdsOf(document.body);
  return renderMarkdown({
    title: options.title ?? 'Title',
    id: DOCUMENT_ID,
    now: options.now ?? NOW,
    document,
    images: new Map(available.map((id, at) => [id, `images/${String(at + 1).padStart(3, '0')}.png`])),
  });
}

const NOTE = '> Draft export — not a provenance-sealed document.';
/** The file below the front matter and the note: the body and the footnotes. */
export function bodyOf(state: Uint8Array | null, options: Parameters<typeof fileOf>[1] = {}): string {
  const file = fileOf(state, options);
  const at = file.indexOf(NOTE);
  if (at < 0) throw new Error('the note is not in the file');
  return file.slice(at + NOTE.length).replace(/^\n+/u, '');
}

/** The body of the file for these blocks. */
export const md = (...blocks: Child[]) => bodyOf(stateOf(...blocks));
