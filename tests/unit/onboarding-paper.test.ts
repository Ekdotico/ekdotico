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
  buildOnboardingState,
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

type Json = {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Json[];
  text?: string;
};

/** A run of text with its marks: `‹bold: bold›`, and a link with its address. */
function inline(node: Json): string {
  if (node.type === 'footnoteReference') return '[footnote]';
  const text = node.text ?? '';
  const marks = (node.marks ?? []).map((mark) =>
    mark.type === 'link' ? `link ${String(mark.attrs?.href)}` : mark.type,
  );
  return marks.length ? `‹${marks.join(' + ')}: ${text}›` : text;
}
const inlineOf = (node: Json) => (node.content ?? []).map(inline).join('');

/** The paper as lines, one for each block, in the words of the approved text. */
function linesOf(node: Json): string[] {
  const children = node.content ?? [];
  switch (node.type) {
    case 'doc':
      return children.flatMap(linesOf);
    case 'tableOfContents':
      return [`[Table of contents, depth ${String(node.attrs?.depth)}]`];
    case 'heading':
      return [`[Heading ${String(node.attrs?.level)}] ${inlineOf(node)}`];
    case 'paragraph':
      return [inlineOf(node)];
    case 'callout':
      return [`[Callout, ${String(node.attrs?.type)}] ${children.map(inlineOf).join(' ')}`];
    case 'blockquote':
      return [`[Quote] ${children.map(inlineOf).join(' ')}`];
    case 'codeBlock':
      return [`[Code block, ${String(node.attrs?.language)}] ${inlineOf(node)}`];
    case 'horizontalRule':
      return ['[Divider]'];
    case 'bulletList':
      return [
        '[Bulleted list]',
        ...children.map((item) => `- ${(item.content ?? []).map(inlineOf).join(' ')}`),
      ];
    case 'orderedList':
      return [
        '[Numbered list]',
        ...children.map((item) => `1. ${(item.content ?? []).map(inlineOf).join(' ')}`),
      ];
    case 'tableBlock':
      return children.flatMap(linesOf);
    case 'table':
      return [
        '[Table]',
        ...children.map((row) =>
          (row.content ?? [])
            .map(
              (cell) =>
                `${cell.type === 'tableHeader' ? 'H:' : ''}${(cell.content ?? []).map(inlineOf).join(' ')}`,
            )
            .join(' / '),
        ),
      ];
    case 'tableCaption':
      return [`[Table caption] ${inlineOf(node)}`];
    case 'footnotes':
      return children.map((entry) => `[Footnote entry] ${inlineOf(entry)}`);
    default:
      throw new Error(`a node the approved text does not have: ${node.type}`);
  }
}

// The approved text of the Onboarding paper, word for word, as the owner read it (the question `ob-text`,
// approved on 22 November 2026). A change to any reader-facing word, label, cell, item, footnote or
// the address of the link fails this test, and a changed text needs the owner's approval first.
const APPROVED = [
  '[Table of contents, depth 3]',
  '[Heading 2] Welcome to Ekdotico α',
  'This is Ekdotico α. α (alpha) is an early version of Ekdotico, made for a small group of people to try. This document teaches the editor, and it is also an example of it: each block you read here is a block you can change. The document belongs to your account, so you can edit it, rename it, or delete it.',
  '[Callout, note] The document saves itself. The indicator in the row of controls under the title says whether the working version is in sync.',
  '[Heading 2] Write and format text',
  'Select some words. A toolbar named Formatting appears with nine controls. This sentence shows each one: ‹bold: bold›, ‹italic: italic›, ‹underline: underline›, ‹strike: strikethrough›, ‹code: inline code›, a superscript (x‹superscript: 2›), a subscript (H‹subscript: 2›O), a ‹link https://ekdoti.co: link›, and ‹highlight: highlight›.',
  'To reach the toolbar with the keyboard, press Alt+F10 while text is selected. Escape returns to the text.',
  '[Table]',
  'H:Action / H:Shortcut / H:What it does',
  'Bold / Cmd or Ctrl+B / Makes the selected text bold',
  'Italic / Cmd or Ctrl+I / Makes the selected text italic',
  'Underline / Cmd or Ctrl+U / Underlines the selected text',
  'Strikethrough / Cmd or Ctrl+Shift+S / Strikes the selected text through',
  'Inline code / Cmd or Ctrl+` / Sets the selected text as code',
  'Link / Cmd or Ctrl+K / Opens the link address field',
  'Undo / Cmd or Ctrl+Z / Reverses your last change',
  'Redo / Cmd or Ctrl+Shift+Z / Restores a change you undid',
  'Indent list item / Tab / Moves the item one level in',
  'Outdent list item / Shift+Tab / Moves the item one level out',
  '[Table caption] Keyboard shortcuts for formatting. Use Cmd on a Mac and Ctrl on other computers.',
  '[Heading 2] Add blocks',
  'A block is one piece of a document, such as a paragraph, a list, or a table. To add one, type / at the start of a line. A list named Blocks opens. Type letters to narrow it, then choose a block.',
  'A plus button named Insert a block also appears beside the cursor at the end of a line when the pointer is near it. Pressing it opens the same list.',
  'The list holds these blocks:',
  '[Bulleted list]',
  '- Text',
  '- Heading 1, Heading 2, and Heading 3',
  '- Bulleted list and Numbered list',
  '- Quote',
  '- Table',
  '- Code block',
  '- Image',
  '- Callout',
  '- Footnote',
  '- Table of contents',
  '- Divider',
  '- Page break',
  'You can also type the Markdown sign for a block, which is a short mark that stands for it. These work at the start of an empty line:',
  '[Bulleted list]',
  '- ‹code: #›, ‹code: ##›, or ‹code: ###› and a space make a heading.',
  '- ‹code: -› or ‹code: *› and a space make a bulleted list.',
  '- ‹code: 1.› and a space make a numbered list.',
  '- ‹code: >› and a space make a quote.',
  '- ‹code: ---› and Enter make a divider.',
  '- Three backticks and Enter make a code block.',
  '[Heading 2] Organise ideas',
  '[Heading 3] Lists and quotes',
  '[Numbered list]',
  '1. Type ‹code: 1.› and a space at the start of a line.',
  '1. Write an item and press Enter.',
  '1. Press Tab to move an item one level in.',
  '[Quote] A quote is set apart from the text around it.',
  '[Heading 3] Tables',
  'Choose Table from the list to add a table of three rows and three columns. Each table has a menu named Table. It holds actions to add or delete rows and columns, merge or split cells, and add a header row. A header row names the columns, which a screen reader reads aloud.',
  '[Heading 3] Code',
  "[Code block, javascript] const greeting = 'Hello, Ekdotico';",
  'Each code block has a language list and a Copy button. Code is not spell-checked.',
  '[Heading 3] Callouts',
  '[Callout, note] A note gives background.',
  '[Callout, tip] A tip suggests a way to work.',
  '[Callout, warning] A warning names something that can go wrong.',
  '[Heading 3] Footnotes and images',
  'A footnote adds a numbered note at the end of the document.[footnote] To add an image, choose Image from the list of blocks. A file picker opens. Pick a PNG, JPEG, or WebP file of up to 20 MB. Give each image alt text, which is a short description for people who cannot see it.',
  '[Divider]',
  '[Heading 2] Work with others',
  "The Sharing button above the document opens the sharing page. There the Owner of a document invites people and gives each an Editor or Viewer role. An Editor can change the document. A Viewer can read it. When several people have a document open, each person's cursor shows in a colour, and their initials appear beside the Sharing button.",
  '[Heading 2] Keep your work',
  'Choose Export as Markdown to save the document as a Markdown file, with its images, in one archive. Markdown is a plain-text way of writing that other tools can read.',
  'In the list of documents, Rename changes a title and Delete document removes a document. A deleted document is kept for a time in Deleted documents, and can be restored there.',
  '[Footnote entry] Footnotes are numbered in the order their markers appear.',
];

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
    // Built again from the JSON each time, not the cached bytes read twice.
    expect(Buffer.from(buildOnboardingState()).equals(Buffer.from(buildOnboardingState()))).toBe(true);
    expect(Buffer.from(onboardingState()).equals(Buffer.from(buildOnboardingState()))).toBe(true);
    // A copy for each caller: what one does to its bytes is not seen by the next.
    const first = onboardingState();
    first.fill(0);
    expect(onboardingState()).not.toEqual(first);
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
    expect(file).toContain('| Action | Shortcut | What it does |');
    expect(file).toContain('Footnotes are numbered in the order their markers appear.');
  });

  it('is the approved text, word for word, in the JSON and in the state the server loads', () => {
    expect(linesOf(onboardingPaper)).toEqual(APPROVED);
    expect(linesOf(rootOf(onboardingState()).toJSON() as Json)).toEqual(APPROVED);
  });
});
