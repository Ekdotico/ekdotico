// The slash command palette (FR-ED-10 to FR-ED-12) as the state of the editor
// holds it: where it opens, what it lists, its keys, and what a choice does
// to the document. tests/e2e/editor.spec.ts presses the keys in a browser,
// where the list is drawn and undo has a document to undo in.
import { Editor, type JSONContent } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { optionListOptionId } from '@ekdotico/domico/components';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import {
  chooseSlashCommand,
  slashAttributes,
  SLASH_LIST_ID,
  SLASH_NAMES,
  slashPalette,
  slashQuery,
  typesSlash,
} from '../../src/app/(app)/documents/[id]/slash-palette.tsx';
import { SLASH_COMMANDS } from '../../src/lib/editor/slash-commands.ts';

type Json = JSONContent;
const words = (text: string, ...marks: string[]): Json => ({
  type: 'text',
  text,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});
const paragraph = (...content: Json[]): Json => ({
  type: 'paragraph',
  ...(content.length ? { content } : {}),
});

/**
 * The editor's own schema and extensions, with no page to stand in, and the
 * cursor in its first text. The library adds the plugins of the extensions
 * when it makes a view, so here they are added by hand: all of them, the rule
 * of FR-ED-18 among them.
 */
function editorOf(...content: Json[]) {
  const made = new Editor({
    element: null,
    content: { type: 'doc', content: content.length ? content : [paragraph()] },
    extensions: extensions(new Y.Doc()),
  });
  made.view.updateState(made.state.reconfigure({ plugins: made.extensionManager.plugins }));
  made.commands.setTextSelection(1);
  return made;
}

/** Puts the cursor at the end of the first block of a type. */
function into(editor: Editor, type: string) {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end < 0 && node.type.name === type) end = pos + node.nodeSize - 1;
  });
  editor.commands.setTextSelection(end);
}

/** Types as a person does: one transaction for each character. */
function type(editor: Editor, text: string) {
  for (const character of text) editor.view.dispatch(editor.state.tr.insertText(character));
}

/**
 * A change of another client, as the collaboration binding applies it
 * (`ProsemirrorBinding._typeChanged` of @tiptap/y-tiptap 3.0.9): the whole
 * document replaced in one step, the cursor put back where it was, and the
 * binding's mark on the transaction. No place maps through it.
 */
function peer(editor: Editor, content: Json[], cursor: number) {
  const next = editor.schema.nodeFromJSON({ type: 'doc', content });
  const tr = editor.state.tr.replace(0, editor.state.doc.content.size, new Slice(next.content, 0, 0));
  tr.setSelection(TextSelection.create(tr.doc, cursor));
  editor.view.dispatch(tr.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: false }));
}

/** A key pressed in the text, as ProseMirror hands it to the palette. True where the palette took it. */
function press(editor: Editor, key: string, more: object = {}): boolean {
  const plugin = editor.state.plugins.find((each) =>
    (each as unknown as { key: string }).key.startsWith('slashPalette$'),
  )!;
  return (
    plugin.props.handleKeyDown!.call(plugin, editor.view, { key, ...more } as unknown as KeyboardEvent) ===
    true
  );
}

const listed = (editor: Editor) => slashPalette(editor.state).options.map(({ id }) => id);
const ALL = SLASH_COMMANDS.map(({ name }) => name);
const json = (editor: Editor) => editor.getJSON().content as Json[];
const text = (editor: Editor) => editor.state.doc.textContent;

describe('where the palette opens (FR-ED-10)', () => {
  it('opens on a slash at the beginning of an empty block, with every row, the first one marked', () => {
    const editor = editorOf();
    expect(slashPalette(editor.state).open).toBe(false);
    type(editor, '/');
    const shown = slashPalette(editor.state);
    expect(shown.open).toBe(true);
    expect(shown.options.map(({ id }) => id)).toEqual(ALL);
    expect(shown.activeId).toBe('text');
    expect(shown.navigating).toBe(false);
  });

  it('opens on a slash that follows a space, and on no other', () => {
    for (const [before, open] of [
      ['word ', true],
      ['word', false],
      ['word.', false],
      ['https:/', false],
      ['a /b', false],
    ] as const) {
      const editor = editorOf(paragraph(words(before)));
      into(editor, 'paragraph');
      type(editor, '/');
      expect(slashPalette(editor.state).open, before).toBe(open);
    }
  });

  it('reads the text of the block and not of one run: a slash after a word in bold follows no space', () => {
    const editor = editorOf(paragraph(words('plain '), words('bold', 'bold')));
    into(editor, 'paragraph');
    editor.view.dispatch(editor.state.tr.insertText('/').setStoredMarks([]));
    type(editor, 'h');
    expect(text(editor)).toBe('plain bold/h');
    expect(slashPalette(editor.state).open).toBe(false);
  });

  it('does not open at the beginning of a block that holds other text', () => {
    const editor = editorOf(paragraph(words('already here')));
    type(editor, '/');
    expect(text(editor)).toBe('/already here');
    expect(slashPalette(editor.state).open).toBe(false);
  });

  it('does not open in a code block', () => {
    const editor = editorOf({ type: 'codeBlock', attrs: { language: 'plaintext' } });
    type(editor, '/');
    expect(slashPalette(editor.state).open).toBe(false);
    type(editor, 'usr /');
    expect(text(editor)).toBe('/usr /');
    expect(slashPalette(editor.state).open).toBe(false);
  });

  it('does not open where no block can stand: the caption of a table', () => {
    const editor = editorOf(SLASH_COMMANDS.find(({ name }) => name === 'table')!.inserts);
    into(editor, 'tableCaption');
    type(editor, '/');
    expect(slashPalette(editor.state).open).toBe(false);
    type(editor, 'x /');
    expect(slashPalette(editor.state).open).toBe(false);
  });

  it('lists only the rows whose block can stand where the command is', () => {
    // A callout holds paragraphs and nothing else.
    const callout = editorOf({ type: 'callout', attrs: { type: 'note' }, content: [paragraph()] });
    type(callout, '/');
    expect(listed(callout)).toEqual(['text']);
    // A list item begins with a paragraph, and takes any block after it.
    const item = editorOf({ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph()] }] });
    type(item, '/');
    expect(listed(item)).toEqual(['text']);
    press(item, 'Escape');
    type(item, ' /');
    expect(listed(item)).toEqual(ALL);
  });

  // The owner's decision of 12 October 2026: the palette opens only when the
  // writer themself typed the slash. Each of the tests to the end of this
  // group that says "does not open" opened the list before that decision.
  it('does not open for a slash already in the text, whatever is typed after it', () => {
    const editor = editorOf(paragraph(words('/h')), paragraph());
    editor.commands.setTextSelection(3);
    expect(slashPalette(editor.state).open).toBe(false);
    type(editor, '1');
    expect(text(editor)).toBe('/h1');
    expect(slashPalette(editor.state).open).toBe(false);
    // Enter is the text's key, and the word stays.
    expect(press(editor, 'Enter')).toBe(false);
    editor.view.dispatch(editor.state.tr.delete(3, 4));
    expect(slashPalette(editor.state).open).toBe(false);
    // Nor for a slash typed elsewhere, while the cursor stays in that word.
    editor.view.dispatch(editor.state.tr.insertText('/', 5));
    expect(editor.state.selection.from).toBe(3);
    expect(slashPalette(editor.state).open).toBe(false);
  });

  it('is asked for by the transaction in which this writer types the slash, and by nothing else', () => {
    const editor = editorOf(paragraph(words('a ')), paragraph(words('far')));
    const range = { from: 3, to: 4 };
    const typed = () => editor.state.tr.insertText('/', 3);
    expect(typesSlash(typed(), range, false)).toBe(true);
    // Typed over a selection, and with a change before it in the same transaction.
    expect(typesSlash(editor.state.tr.insertText('/', 2, 3), { from: 2, to: 3 }, false)).toBe(true);
    expect(typesSlash(editor.state.tr.insertText('/', 3).insertText('b', 1), { from: 4, to: 5 }, false)).toBe(
      true,
    );
    // An input method that is composing has not committed what it shows.
    expect(typesSlash(typed(), range, true)).toBe(false);
    // Another client's change, an undo and a redo arrive from the collaboration binding.
    for (const isUndoRedoOperation of [false, true]) {
      const arrived = typed().setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation });
      expect(typesSlash(arrived, range, false)).toBe(false);
    }
    // A paste and a drop, as ProseMirror marks them: of a slash alone too.
    expect(typesSlash(typed().setMeta('paste', true).setMeta('uiEvent', 'paste'), range, false)).toBe(false);
    expect(typesSlash(typed().setMeta('uiEvent', 'drop'), range, false)).toBe(false);
    // A slash that arrives with other text: a paste that carries no mark, an input rule.
    expect(typesSlash(editor.state.tr.insertText('/h', 3), { from: 3, to: 5 }, false)).toBe(false);
    expect(typesSlash(editor.state.tr.insertText(' /', 3), { from: 4, to: 5 }, false)).toBe(false);
    // Another character typed in the command, a slash typed elsewhere, a change elsewhere, a move.
    expect(typesSlash(editor.state.tr.insertText('h', 3), range, false)).toBe(false);
    expect(typesSlash(editor.state.tr.insertText('/', 8), range, false)).toBe(false);
    expect(typesSlash(editor.state.tr.insertText('!', 8), range, false)).toBe(false);
    expect(typesSlash(editor.state.tr.setMeta('moved', true), range, false)).toBe(false);
  });

  it('does not open on a slash that another client puts before the word the writer is typing', () => {
    const editor = editorOf();
    type(editor, 'cod');
    peer(editor, [paragraph(words('/cod'))], 5);
    expect(slashPalette(editor.state).open).toBe(false);
    type(editor, 'e');
    expect(text(editor)).toBe('/code');
    expect(slashPalette(editor.state).open).toBe(false);
    expect(slashAttributes(editor.state)).toStrictEqual({});
    // Enter is the text's key: no block is put in place of the word.
    expect(press(editor, 'Enter')).toBe(false);
    expect(json(editor)).toEqual([paragraph(words('/code'))]);
    // After a space too, and when the other client joins the writer's own words into a command.
    const joined = editorOf(paragraph(words('see /c de mine')));
    joined.commands.setTextSelection(7);
    peer(joined, [paragraph(words('see /cde mine'))], 7);
    type(joined, 'o');
    expect(text(joined)).toBe('see /code mine');
    expect(slashPalette(joined.state).open).toBe(false);
    expect(press(joined, 'Enter')).toBe(false);
  });

  it('does not open on a slash that was pasted, nor on one that an undo or a redo brought back', () => {
    const pasted = editorOf();
    pasted.view.dispatch(pasted.state.tr.insertText('/h').setMeta('paste', true).setMeta('uiEvent', 'paste'));
    expect(slashPalette(pasted.state).open).toBe(false);
    type(pasted, '1');
    expect(text(pasted)).toBe('/h1');
    expect(slashPalette(pasted.state).open).toBe(false);

    const alone = editorOf();
    alone.view.dispatch(alone.state.tr.insertText('/').setMeta('paste', true).setMeta('uiEvent', 'paste'));
    type(alone, 'h');
    expect(text(alone)).toBe('/h');
    expect(slashPalette(alone.state).open).toBe(false);

    // The binding applies an undo as it applies another client's change, and says which it is.
    const undone = editorOf();
    type(undone, '/h');
    undone.view.dispatch(undone.state.tr.delete(1, 3));
    const back = undone.schema.nodeFromJSON({ type: 'doc', content: [paragraph(words('/h'))] });
    const tr = undone.state.tr.replace(0, undone.state.doc.content.size, new Slice(back.content, 0, 0));
    tr.setSelection(TextSelection.create(tr.doc, 3));
    undone.view.dispatch(tr.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: true }));
    expect(text(undone)).toBe('/h');
    expect(slashPalette(undone.state).open).toBe(false);
    type(undone, '1');
    expect(slashPalette(undone.state).open).toBe(false);
  });

  it('does not open again on the writer’s own slash once the cursor has left the command and come back', () => {
    const editor = editorOf(paragraph(), paragraph(words('below')));
    type(editor, '/h');
    expect(slashPalette(editor.state).open).toBe(true);
    editor.commands.setTextSelection(6);
    expect(slashPalette(editor.state).open).toBe(false);
    editor.commands.setTextSelection(3);
    expect(slashPalette(editor.state).open).toBe(false);
    type(editor, '1');
    expect(text(editor)).toBe('/h1below');
    expect(slashPalette(editor.state).open).toBe(false);
    // The writer asks again by typing a slash again.
    editor.view.dispatch(editor.state.tr.delete(1, 4));
    type(editor, '/');
    expect(slashPalette(editor.state).open).toBe(true);
  });

  it('opens on a slash the writer types before a word, and on one typed over the command it was closed on', () => {
    const before = editorOf(paragraph(words('cod')));
    type(before, '/');
    expect(text(before)).toBe('/cod');
    expect(listed(before)).toEqual(['code']);

    const over = editorOf();
    type(over, '/h');
    press(over, 'Escape');
    over.view.dispatch(over.state.tr.insertText('/', 1, 3));
    expect(text(over)).toBe('/');
    expect(slashPalette(over.state).open).toBe(true);
  });

  it('stays as it is through another client’s change, at the row the writer moved to', () => {
    const editor = editorOf(paragraph(words('above')), paragraph());
    editor.commands.setTextSelection(8);
    type(editor, '/h');
    press(editor, 'ArrowDown');
    expect(slashPalette(editor.state).activeId).toBe('h2');
    // Elsewhere in the document: the list stays, and Enter chooses the row.
    peer(editor, [paragraph(words('More above')), paragraph(words('/h'))], 15);
    expect(slashPalette(editor.state)).toMatchObject({
      open: true,
      activeId: 'h2',
      navigating: true,
      range: { from: 13, to: 15 },
    });
    peer(editor, [paragraph(words('More')), paragraph(words('/h')), paragraph(words('Below'))], 9);
    expect(slashPalette(editor.state)).toMatchObject({
      open: true,
      activeId: 'h2',
      range: { from: 7, to: 9 },
    });
    expect(press(editor, 'Enter')).toBe(true);
    expect(json(editor)).toEqual([
      paragraph(words('More')),
      { type: 'heading', attrs: { level: 2 } },
      paragraph(words('Below')),
    ]);
  });

  it('closes when another client rewrites the command, or takes its block away, and nothing is inserted', () => {
    const rewritten = editorOf(paragraph(words('above')), paragraph());
    rewritten.commands.setTextSelection(8);
    type(rewritten, '/h');
    peer(rewritten, [paragraph(words('above')), paragraph(words('/ta'))], 11);
    expect(slashPalette(rewritten.state).open).toBe(false);
    expect(slashAttributes(rewritten.state)).toStrictEqual({});
    expect(press(rewritten, 'Enter')).toBe(false);
    expect(json(rewritten)).toEqual([paragraph(words('above')), paragraph(words('/ta'))]);

    const gone = editorOf(paragraph(words('above')), paragraph());
    gone.commands.setTextSelection(8);
    type(gone, '/h');
    peer(gone, [paragraph(words('above'))], 6);
    expect(slashPalette(gone.state).open).toBe(false);
    expect(press(gone, 'Enter')).toBe(false);
    expect(json(gone)).toEqual([paragraph(words('above'))]);
  });

  // The review of pull request 25. A plugin appends a transaction to another
  // client's change: the paragraph kept at the end of a document, the repair
  // of a table. The rule read the state before the whole dispatch for it, in
  // which the list was still open, and opened the list again on what the
  // other client wrote: Enter then put a code block in place of "/code", and
  // the writer's "de" with it.
  const RULE: Json = { type: 'horizontalRule' };
  /** A table whose second row is a cell short, which the library's own plugin repairs. */
  const ragged = (): Json => {
    const block = structuredClone(SLASH_COMMANDS.find(({ name }) => name === 'table')!.inserts) as Json;
    block.content!.find(({ type }) => type === 'table')!.content![1]!.content!.pop();
    return block;
  };
  const cellsOfRows = (editor: Editor) => {
    const rows: number[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableRow') rows.push(node.childCount);
    });
    return rows;
  };
  /** The place after the first text that is `written`, in a document of these blocks. */
  const after = (editor: Editor, content: Json[], written: string) => {
    let end = -1;
    editor.schema.nodeFromJSON({ type: 'doc', content }).descendants((node, pos) => {
      if (end < 0 && node.isText && node.text === written) end = pos + written.length;
    });
    expect(end, written).toBeGreaterThan(0);
    return end;
  };

  it('closes when another client rewrites the command in a change that a plugin appends a transaction to', () => {
    for (const [name, last] of [
      ['a rule put last', RULE],
      ['a page break put last', { type: 'pageBreak' }],
      ['a table a cell short', ragged()],
    ] as const) {
      const editor = editorOf(paragraph(words('see  de mine')));
      editor.commands.setTextSelection(5);
      type(editor, '/co');
      expect(listed(editor), name).toEqual(['code', 'toc']);
      // The other client takes away the space after the command, and adds a block.
      peer(editor, [paragraph(words('see /code mine')), last], 8);
      // The plugin did append: a paragraph ends the document, and the table has whole rows.
      expect(editor.state.doc.lastChild!.type.name, name).toBe('paragraph');
      expect(editor.state.doc.childCount, name).toBe(3);
      expect(new Set(cellsOfRows(editor)).size, name).toBeLessThanOrEqual(1);
      expect(slashPalette(editor.state).open, name).toBe(false);
      expect(slashAttributes(editor.state), name).toStrictEqual({});
      // Enter is the text's key: no block is put in place of the writer's words.
      expect(press(editor, 'Enter'), name).toBe(false);
      expect(editor.state.doc.firstChild!.textContent, name).toBe('see /code mine');
    }

    // The rows of an open list changed under it: "/h" made "/hr", whose first row is the divider.
    const editor = editorOf();
    type(editor, '/h');
    expect(slashPalette(editor.state).activeId).toBe('h1');
    peer(editor, [paragraph(words('/hr')), RULE], 3);
    expect(editor.state.doc.childCount).toBe(3);
    expect(slashPalette(editor.state).open).toBe(false);
    expect(press(editor, 'Enter')).toBe(false);

    // Closed with Escape, then such a change, then the writer's own letter.
    const escaped = editorOf();
    type(escaped, '/h');
    press(escaped, 'Escape');
    peer(escaped, [paragraph(words('/h')), RULE], 3);
    expect(slashPalette(escaped.state).open).toBe(false);
    type(escaped, '1');
    expect(escaped.state.doc.firstChild!.textContent).toBe('/h1');
    expect(slashPalette(escaped.state).open).toBe(false);
  });

  it('stays as it is through another client’s change elsewhere that a plugin appends a transaction to', () => {
    const editor = editorOf(paragraph(words('above')), paragraph());
    editor.commands.setTextSelection(8);
    type(editor, '/h');
    press(editor, 'ArrowDown');
    for (const last of [RULE, ragged()]) {
      const content = [paragraph(words('More above')), paragraph(words('/h')), last];
      peer(editor, content, after(editor, content, '/h'));
      expect(editor.state.doc.childCount).toBe(4);
      expect(new Set(cellsOfRows(editor)).size).toBeLessThanOrEqual(1);
      expect(slashPalette(editor.state)).toMatchObject({
        open: true,
        activeId: 'h2',
        navigating: true,
        range: { from: 13, to: 15 },
      });
    }
    expect(press(editor, 'Enter')).toBe(true);
    expect(json(editor)[1]).toEqual({ type: 'heading', attrs: { level: 2 } });
  });

  it('closes when another client puts the same text in another kind of block, with an appended transaction or without', () => {
    const table = (cell: string, caption: string): Json => {
      const block = structuredClone(SLASH_COMMANDS.find(({ name }) => name === 'table')!.inserts) as Json;
      const first = block.content!.find(({ type }) => type === 'table')!.content![0]!.content![0]!;
      first.content = [paragraph(...(cell ? [words(cell)] : []))];
      const under = block.content!.find(({ type }) => type === 'tableCaption')!;
      if (caption) under.content = [words(caption)];
      return block;
    };
    for (const [name, content] of [
      ['a callout', [{ type: 'callout', attrs: { type: 'note' }, content: [paragraph(words('/h'))] }]],
      [
        'a list item',
        [{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(words('/h'))] }] }],
      ],
      ['a heading', [{ type: 'heading', attrs: { level: 1 }, content: [words('/h')] }]],
      ['a quotation', [{ type: 'blockquote', content: [paragraph(words('/h'))] }]],
      ['a code block', [{ type: 'codeBlock', attrs: { language: 'plaintext' }, content: [words('/h')] }]],
      ['a cell of a table', [table('/h', '')]],
      ['the caption of a table', [table('', '/h')]],
    ] as [string, Json[]][]) {
      for (const tail of [[paragraph()], []]) {
        const editor = editorOf();
        type(editor, '/h');
        expect(slashPalette(editor.state).open, name).toBe(true);
        const all = [...content, ...tail];
        peer(editor, all, after(editor, all, '/h'));
        expect(editor.state.selection.$from.parent.textContent, name).toBe('/h');
        expect(slashPalette(editor.state).open, `${name}, ${tail.length} after`).toBe(false);
        expect(press(editor, 'Enter'), name).toBe(false);
      }
    }
  });

  it('stays closed after Escape through another client’s change, and when that client rewrites the command', () => {
    const editor = editorOf(paragraph(words('above')), paragraph());
    editor.commands.setTextSelection(8);
    type(editor, '/h');
    press(editor, 'Escape');
    peer(editor, [paragraph(words('More above')), paragraph(words('/h'))], 15);
    type(editor, '1');
    expect(text(editor)).toBe('More above/h1');
    expect(slashPalette(editor.state).open).toBe(false);
    peer(editor, [paragraph(words('Yet more above')), paragraph(words('/h1'))], 20);
    type(editor, '2');
    expect(slashPalette(editor.state).open).toBe(false);
    // Another command now, by another's hand: its slash is not the writer's, and typing in it asks for nothing.
    peer(editor, [paragraph(words('above')), paragraph(words('/he'))], 11);
    expect(slashPalette(editor.state).open).toBe(false);
    type(editor, 'a');
    expect(text(editor)).toBe('above/hea');
    expect(slashPalette(editor.state).open).toBe(false);
  });

  it('closes when the text loses the focus, and when the document can no longer be edited (FR-ED-18)', () => {
    const blurred = editorOf();
    type(blurred, '/');
    blurred.emit('blur', { editor: blurred, event: {} as FocusEvent, transaction: blurred.state.tr });
    expect(slashPalette(blurred.state).open).toBe(false);
    expect(text(blurred)).toBe('/');

    const lost = editorOf();
    type(lost, '/h1');
    lost.setEditable(false);
    expect(slashPalette(lost.state).open).toBe(false);
    expect(slashAttributes(lost.state)).toStrictEqual({});
    // Nothing typed opens it, were anything typed.
    lost.view.dispatch(lost.state.tr.setMeta('anything', true));
    expect(slashPalette(lost.state).open).toBe(false);
  });
});

describe('the filter and the rows (FR-ED-11, FR-ED-12)', () => {
  it('filters as the query is typed, by name and by alias, without regard to case', () => {
    const editor = editorOf();
    type(editor, '/h');
    expect(slashPalette(editor.state).options).toEqual([
      { id: 'h1', label: 'Heading 1', detail: '/h1' },
      { id: 'h2', label: 'Heading 2', detail: '/h2' },
      { id: 'h3', label: 'Heading 3', detail: '/h3' },
      { id: 'divider', label: 'Divider', detail: '/divider' },
    ]);
    type(editor, 'R');
    expect(listed(editor)).toEqual(['divider']);
    type(editor, 'x');
    // Nothing matches: the palette is open and empty, and the text names no list.
    expect(slashPalette(editor.state)).toMatchObject({ open: true, options: [], activeId: null });
    expect(slashAttributes(editor.state)).toStrictEqual({});
    // Enter is then the text's key.
    expect(press(editor, 'Enter')).toBe(false);
    expect(text(editor)).toBe('/hRx');
  });

  it('names every row, and gives each an id that an element can carry', () => {
    expect(Object.keys(SLASH_NAMES)).toEqual(ALL);
    for (const name of ALL) {
      expect(SLASH_NAMES[name]).toMatch(/^[A-Z][a-z]+( [a-z0-9]+)*$/);
      expect(name).toMatch(/^[a-z0-9-]+$/);
    }
    expect(new Set(Object.values(SLASH_NAMES)).size).toBe(ALL.length);
  });

  it('inserts a table of plain rows: no header row (the owner’s decision of 9 October 2026)', () => {
    const editor = editorOf();
    type(editor, '/table');
    press(editor, 'Enter');
    const cells: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell')
        cells.push(node.type.name);
    });
    expect(cells).toEqual(Array(9).fill('tableCell'));
  });
});

describe('the keys of the palette, and what the text says of it (NFR-IC-19)', () => {
  it('names the list while it shows a row, and the marked row only while the writer moves in the list', () => {
    const editor = editorOf();
    expect(slashAttributes(editor.state)).toStrictEqual({});
    type(editor, '/');
    expect(slashAttributes(editor.state)).toStrictEqual({ 'aria-controls': SLASH_LIST_ID });

    expect(press(editor, 'ArrowDown')).toBe(true);
    expect(slashPalette(editor.state)).toMatchObject({ activeId: 'h1', navigating: true });
    expect(slashAttributes(editor.state)).toStrictEqual({
      'aria-controls': SLASH_LIST_ID,
      'aria-activedescendant': optionListOptionId(SLASH_LIST_ID, 'h1'),
    });
    // A modifier pressed by itself is no move away: it silences a screen reader.
    expect(press(editor, 'Control')).toBe(false);
    expect(slashAttributes(editor.state)['aria-activedescendant']).toBe(
      optionListOptionId(SLASH_LIST_ID, 'h1'),
    );
    expect(press(editor, 'ArrowUp')).toBe(true);
    expect(press(editor, 'ArrowUp')).toBe(true);
    expect(slashPalette(editor.state).activeId).toBe('text');
    expect(press(editor, 'PageDown')).toBe(true);
    expect(slashPalette(editor.state).activeId).toBe('code');

    // A key of the text ends the move, before its letter arrives; the letter starts the filter at its first match.
    expect(press(editor, 'c')).toBe(false);
    expect(slashAttributes(editor.state)).toStrictEqual({ 'aria-controls': SLASH_LIST_ID });
    type(editor, 'c');
    expect(slashPalette(editor.state)).toMatchObject({ activeId: 'code', navigating: false });
    expect(listed(editor)).toEqual(['code', 'callout', 'toc']);
    press(editor, 'ArrowDown');
    type(editor, 'a');
    expect(slashPalette(editor.state)).toMatchObject({ activeId: 'callout', navigating: false });
    expect(slashAttributes(editor.state)).toStrictEqual({ 'aria-controls': SLASH_LIST_ID });
  });

  it('leaves the keys of the text to the text, and every key to an input method that is composing', () => {
    const editor = editorOf();
    type(editor, '/h');
    for (const each of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'a']) {
      expect(press(editor, each), each).toBe(false);
    }
    for (const each of ['Enter', 'ArrowDown', 'ArrowUp']) {
      expect(press(editor, each, { isComposing: true }), each).toBe(false);
      expect(press(editor, each, { keyCode: 229 }), each).toBe(false);
      expect(press(editor, each, { shiftKey: true }), each).toBe(false);
    }
    expect(text(editor)).toBe('/h');
    expect(slashPalette(editor.state)).toMatchObject({ open: true, activeId: 'h1', navigating: false });
  });

  it('closes on Escape, keeps what was typed, and stays closed for that slash', () => {
    const editor = editorOf();
    type(editor, '/h');
    // True: the key was the palette's, so nothing else on the page is closed by it.
    expect(press(editor, 'Escape')).toBe(true);
    expect(slashPalette(editor.state).open).toBe(false);
    expect(slashAttributes(editor.state)).toStrictEqual({});
    expect(text(editor)).toBe('/h');
    expect(editor.state.selection.from).toBe(3);
    type(editor, '1');
    expect(text(editor)).toBe('/h1');
    expect(slashPalette(editor.state).open).toBe(false);
    // Closed, Escape is not the palette's.
    expect(press(editor, 'Escape')).toBe(false);
    // The next slash is a new request.
    type(editor, ' /');
    expect(slashPalette(editor.state).open).toBe(true);
  });
});

describe('a choice (FR-ED-12)', () => {
  it.each(SLASH_COMMANDS.map((command) => [command.name, command] as const))(
    '/%s, chosen with Enter in an empty block, puts its block in place of what was typed',
    (name, { inserts }) => {
      const editor = editorOf();
      type(editor, `/${name}`);
      expect(slashPalette(editor.state).activeId).toBe(name);
      expect(press(editor, 'Enter')).toBe(true);

      const [first, second, ...rest] = editor.state.doc.children;
      expect(first!.type.name).toBe(inserts.type);
      expect(first!.attrs).toMatchObject(inserts.attrs ?? {});
      expect(text(editor)).not.toContain('/');
      expect(slashPalette(editor.state).open).toBe(false);
      editor.state.doc.check();
      // The cursor is in text: inside the block, or after a block that holds none.
      const { $from, empty } = editor.state.selection;
      expect(empty).toBe(true);
      expect($from.parent.isTextblock).toBe(true);
      if (first!.isLeaf) {
        expect(second!.type.name).toBe('paragraph');
        expect($from.pos).toBe(first!.nodeSize + 1);
      } else {
        expect($from.node(1)).toBe(first);
      }
      // Nothing else is made, but the paragraph the library keeps at the end of a document.
      expect([second, ...rest].filter(Boolean).map((node) => node!.type.name)).toEqual(
        inserts.type === 'paragraph' ? [] : ['paragraph'],
      );
    },
  );

  it('replaces exactly the command where it follows a space: the block stands between what was before and after', () => {
    const editor = editorOf(paragraph(words('before  after')));
    editor.commands.setTextSelection(8);
    type(editor, '/H2');
    press(editor, 'Enter');
    expect(json(editor)).toEqual([
      paragraph(words('before ')),
      { type: 'heading', attrs: { level: 2 } },
      paragraph(words(' after')),
    ]);
    expect(editor.state.selection.from).toBe(10);
  });

  it('puts the block after the block the command ends, and the cursor in it', () => {
    const editor = editorOf({ type: 'heading', attrs: { level: 1 }, content: [words('Title')] });
    into(editor, 'heading');
    type(editor, ' /quote');
    press(editor, 'Enter');
    expect(json(editor)).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [words('Title ')] },
      { type: 'blockquote', content: [paragraph()] },
      paragraph(),
    ]);
    expect(editor.state.selection.$from.node(1).type.name).toBe('blockquote');
  });

  it('follows a block that holds no text with a paragraph where none follows, and with none where one does', () => {
    const last = editorOf({ type: 'blockquote', content: [paragraph(words('Quoted'))] });
    into(last, 'paragraph');
    type(last, ' /divider');
    press(last, 'Enter');
    expect(json(last)[0]).toEqual({
      type: 'blockquote',
      content: [paragraph(words('Quoted ')), { type: 'horizontalRule' }, paragraph()],
    });
    expect(last.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(last.state.selection.$from.depth).toBe(2);

    const followed = editorOf(paragraph(), paragraph(words('Next')));
    type(followed, '/page-break');
    press(followed, 'Enter');
    expect(json(followed)).toEqual([{ type: 'pageBreak' }, paragraph(words('Next'))]);
    expect(followed.state.selection.from).toBe(2);
  });

  it('chooses the row the writer moved to, and no row that is not listed', () => {
    const editor = editorOf();
    type(editor, '/h');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    // Not listed under this query.
    chooseSlashCommand(editor, 'table');
    expect(text(editor)).toBe('/h');
    press(editor, 'Enter');
    expect(json(editor)[0]).toEqual({ type: 'heading', attrs: { level: 3 } });
    // Closed: nothing to replace.
    chooseSlashCommand(editor, 'table');
    expect(json(editor)[0]).toEqual({ type: 'heading', attrs: { level: 3 } });

    const callout = editorOf({ type: 'callout', attrs: { type: 'note' }, content: [paragraph()] });
    type(callout, '/');
    chooseSlashCommand(callout, 'h1');
    expect(text(callout)).toBe('/');
  });

  it('changes nothing in a document that cannot be edited (FR-ED-18)', () => {
    const editor = editorOf();
    type(editor, '/h1');
    // Without the event that closes the palette: the state still holds it open.
    editor.setEditable(false, false);
    expect(slashPalette(editor.state).open).toBe(true);
    press(editor, 'Enter');
    chooseSlashCommand(editor, 'h1');
    expect(json(editor)).toEqual([paragraph(words('/h1'))]);
  });
});

describe('the command is the whole word the slash begins, wherever the cursor stands in it', () => {
  it('filters on what the writer sees, and a choice replaces all of it', () => {
    const editor = editorOf();
    type(editor, '/h1');
    editor.commands.setTextSelection(3);
    // The cursor is between the h and the 1: the query is still h1.
    expect(slashPalette(editor.state)).toMatchObject({ open: true, range: { from: 1, to: 4 } });
    expect(listed(editor)).toEqual(['h1']);
    editor.commands.setTextSelection(2);
    expect(listed(editor)).toEqual(['h1']);
    press(editor, 'Enter');
    expect(json(editor)).toEqual([{ type: 'heading', attrs: { level: 1 } }, paragraph()]);
  });

  it('takes the word to the next white space, after a space as at the beginning', () => {
    const editor = editorOf(paragraph(words('before  after')));
    editor.commands.setTextSelection(8);
    type(editor, '/quote');
    editor.commands.setTextSelection(10);
    expect(slashPalette(editor.state)).toMatchObject({ open: true, range: { from: 8, to: 14 } });
    expect(listed(editor)).toEqual(['quote']);
    // A letter typed inside the word is part of the query.
    type(editor, 'x');
    expect(slashPalette(editor.state)).toMatchObject({ open: true, options: [], range: { from: 8, to: 15 } });
    editor.view.dispatch(editor.state.tr.delete(10, 11));
    press(editor, 'Enter');
    expect(json(editor)).toEqual([
      paragraph(words('before ')),
      { type: 'blockquote', content: [paragraph()] },
      paragraph(words(' after')),
    ]);
  });

  it('closes when the cursor is before the slash, past the word, or a range', () => {
    for (const [anchor, head] of [
      [3, 3],
      [1, 1],
      [4, 5],
      [3, 5],
    ] as const) {
      const editor = editorOf(paragraph(words('a ')));
      into(editor, 'paragraph');
      type(editor, '/h');
      expect(slashPalette(editor.state).open, `${anchor}`).toBe(true);
      editor.commands.setTextSelection({ from: anchor, to: head });
      expect(slashPalette(editor.state).open, `${anchor} to ${head}`).toBe(false);
      expect(slashAttributes(editor.state)).toStrictEqual({});
    }
  });

  it('is no command where the word holds a second slash, on either side of the cursor', () => {
    const editor = editorOf(paragraph(words('see /usr/bin')));
    editor.commands.setTextSelection(7);
    type(editor, 'x');
    expect(text(editor)).toBe('see /uxsr/bin');
    expect(slashPalette(editor.state).open).toBe(false);
  });
});

describe('Tab, and a table in a table', () => {
  it('closes on Tab and on Shift+Tab, and leaves the key to the text', () => {
    for (const more of [{}, { shiftKey: true }]) {
      const editor = editorOf();
      type(editor, '/');
      // False: the key is not taken, so it leaves the text, or indents a list item, as it does.
      expect(press(editor, 'Tab', more)).toBe(false);
      expect(slashPalette(editor.state).open).toBe(false);
      expect(slashAttributes(editor.state)).toStrictEqual({});
      expect(text(editor)).toBe('/');
      // As after Escape: that slash opens nothing again.
      type(editor, 'h');
      expect(slashPalette(editor.state).open).toBe(false);
    }
  });

  // The owner's decision R32 of 12 October 2026: "Allow it, and list Table in
  // the palette inside a table." Within the bounds the tables share
  // (table-bounds.ts): two levels, and ten thousand cells.
  const TABLE = SLASH_COMMANDS.find(({ name }) => name === 'table')!.inserts;
  const OTHERS = ALL.filter((name) => name !== 'table');
  /** The blocks round the cursor, from the document inwards. */
  const round = (editor: Editor) => {
    const { $from } = editor.state.selection;
    return Array.from({ length: $from.depth + 1 }, (_, depth) => $from.node(depth).type.name);
  };
  /** The rows of each table, outermost first. */
  const rowsOf = (editor: Editor) => {
    const found: number[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'table') found.push(node.childCount);
    });
    return found;
  };
  const cells = (rows: number, columns: number, first: Json[] = [paragraph()]): Json => ({
    type: 'tableBlock',
    content: [
      {
        type: 'table',
        content: Array.from({ length: rows }, (_, row) => ({
          type: 'tableRow',
          content: Array.from({ length: columns }, (_, column) => ({
            type: 'tableCell',
            content: row + column ? [paragraph()] : first,
          })),
        })),
      },
      { type: 'tableCaption' },
    ],
  });
  /** A key pressed in the text, as ProseMirror hands it to every plugin in turn. True where one took it. */
  const key = (editor: Editor, name: string, shiftKey = false) =>
    editor.state.plugins.some(
      (plugin) =>
        plugin.props.handleKeyDown?.call(plugin, editor.view, {
          key: name,
          keyCode: name === 'Tab' ? 9 : 0,
          shiftKey,
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          preventDefault() {},
        } as unknown as KeyboardEvent) === true,
    );

  it('lists Table in a cell of a table, and puts one there: the cursor in its first cell, and a paragraph after it in the cell', () => {
    const editor = editorOf(TABLE);
    type(editor, '/');
    expect(listed(editor)).toEqual(ALL);
    type(editor, 'table');
    expect(press(editor, 'Enter')).toBe(true);
    expect(rowsOf(editor)).toEqual([3, 3]);
    editor.state.doc.check();
    expect(text(editor)).toBe('');
    // In the first cell of the new table, which stands in the first cell of the other.
    const inner = ['tableBlock', 'table', 'tableRow', 'tableCell'];
    expect(round(editor)).toEqual(['doc', ...inner, ...inner, 'paragraph']);
    const { $from } = editor.state.selection;
    expect([$from.index(2), $from.index(3), $from.index(6), $from.index(7)]).toEqual([0, 0, 0, 0]);
    // The cell holds the table and then a paragraph: a place to write in that is the cell's own.
    expect($from.node(4).children.map(({ type }) => type.name)).toEqual(['tableBlock', 'paragraph']);
    // After text in a cell, the table follows the text, and a paragraph the table.
    const after = editorOf(TABLE);
    type(after, 'words /table');
    press(after, 'Enter');
    expect(after.state.doc.firstChild!.firstChild!.firstChild!.firstChild!.toString()).toMatch(
      /^tableCell\(paragraph\("words "\), tableBlock\(.*\), paragraph\)$/,
    );
  });

  it('lists no table a level too deep: not in a cell of a table that stands in a cell, nor in a quotation there', () => {
    const editor = editorOf(TABLE);
    type(editor, '/table');
    press(editor, 'Enter');
    type(editor, '/');
    expect(listed(editor)).toEqual(OTHERS);
    chooseSlashCommand(editor, 'table');
    expect(text(editor)).toBe('/');
    type(editor, 'table');
    expect(slashPalette(editor.state)).toMatchObject({ open: true, options: [] });
    expect(press(editor, 'Enter')).toBe(false);
    // In a quotation in that cell.
    const { from } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.delete(from - 5, from));
    type(editor, 'quote');
    press(editor, 'Enter');
    type(editor, 'Quoted /');
    expect(listed(editor)).toEqual(OTHERS);
    expect(rowsOf(editor)).toEqual([3, 3]);
    // And in the paragraph after the table, in the cell of the first table, it is listed again.
    editor.commands.setTextSelection(editor.state.doc.content.size);
    expect(round(editor)).toEqual(['doc', 'paragraph']);
    type(editor, '/');
    expect(listed(editor)).toEqual(ALL);
  });

  it('lists no table where the tables round the cursor have no room for its nine cells', () => {
    // 9,900 cells, and a table in the first: of 91 cells, which leaves room for nine, and of 92.
    const room = editorOf(cells(99, 100, [paragraph(), cells(7, 13)]));
    type(room, '/');
    expect(listed(room)).toEqual(ALL);
    type(room, 'table');
    press(room, 'Enter');
    expect(rowsOf(room)).toEqual([99, 3, 7]);
    const none = editorOf(cells(99, 100, [paragraph(), cells(4, 23)]));
    type(none, '/');
    expect(listed(none)).toEqual(OTHERS);
    chooseSlashCommand(none, 'table');
    expect(rowsOf(none)).toEqual([99, 4]);
    // The largest table there is has room for none.
    const full = editorOf(cells(100, 100));
    type(full, '/');
    expect(listed(full)).toEqual(OTHERS);
  });

  describe('the keys and the commands of a table in a cell', () => {
    /** Two by two in the first cell of two by two, and the cursor in the first cell of the inner one. */
    const nested = () => {
      const editor = editorOf(cells(2, 2, [cells(2, 2), paragraph()]));
      expect(round(editor).filter((name) => name === 'table')).toHaveLength(2);
      return editor;
    };
    const place = (editor: Editor) => {
      const { $from } = editor.state.selection;
      const table = round(editor).lastIndexOf('table');
      return `${round(editor).filter((name) => name === 'table').length}:${$from.index(table)}.${$from.index(table + 1)}`;
    };

    it('Tab and Shift+Tab move between the cells of the innermost table', () => {
      const editor = nested();
      expect(place(editor)).toBe('2:0.0');
      for (const next of ['2:0.1', '2:1.0', '2:1.1']) {
        expect(key(editor, 'Tab')).toBe(true);
        expect(place(editor)).toBe(next);
      }
      for (const before of ['2:1.0', '2:0.1', '2:0.0']) {
        expect(key(editor, 'Tab', true)).toBe(true);
        expect(place(editor)).toBe(before);
      }
      // At its first cell Shift+Tab is not the table's: it does not step into the table round it.
      expect(key(editor, 'Tab', true)).toBe(false);
      expect(place(editor)).toBe('2:0.0');
    });

    it('Tab in its last cell adds a row to it, and none to the table round it', () => {
      const editor = nested();
      for (let presses = 0; presses < 4; presses += 1) key(editor, 'Tab');
      expect(rowsOf(editor)).toEqual([2, 3]);
      expect(place(editor)).toBe('2:2.0');
    });

    it('the row and column commands act on the innermost table', () => {
      const editor = nested();
      const shape = () => {
        const found: string[] = [];
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'table')
            found.push(
              `${node.childCount}x${node.firstChild!.childCount} ${node.firstChild!.firstChild!.type.name}`,
            );
        });
        return found;
      };
      expect(shape()).toEqual(['2x2 tableCell', '2x2 tableCell']);
      editor.commands.addRowBefore();
      editor.commands.addColumnAfter();
      expect(shape()).toEqual(['2x2 tableCell', '3x3 tableCell']);
      editor.commands.toggleHeaderRow();
      expect(shape()).toEqual(['2x2 tableCell', '3x3 tableHeader']);
      // The row and the column of the cursor go: the header row, which was added above it, stays.
      editor.commands.deleteRow();
      editor.commands.deleteColumn();
      expect(shape()).toEqual(['2x2 tableCell', '2x2 tableHeader']);
      editor.state.doc.check();
    });

    it('add no cell past the bound the tables share: Tab in the last cell, a row and a column change nothing', () => {
      // 9,900 cells, and ten by ten in the first: 10,000.
      const editor = editorOf(cells(99, 100, [cells(10, 10), paragraph()]));
      const before = editor.state.doc;
      editor.commands.addRowAfter();
      editor.commands.addColumnBefore();
      expect(editor.state.doc.eq(before)).toBe(true);
      // To the last cell of the inner table, and Tab there.
      for (let presses = 0; presses < 99; presses += 1) key(editor, 'Tab');
      expect(place(editor)).toBe('2:9.9');
      key(editor, 'Tab');
      expect(editor.state.doc.eq(before)).toBe(true);
      expect(rowsOf(editor)).toEqual([99, 10]);
      // And what adds none is applied.
      editor.commands.deleteRow();
      expect(rowsOf(editor)).toEqual([99, 9]);
    });

    const one = (word: string): Json => ({
      type: 'tableBlock',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(words(word))] }] },
          ],
        },
        { type: 'tableCaption', content: [words(`${word} caption`)] },
      ],
    });
    const rowOf = (...held: Json[][]): Json => ({
      type: 'tableBlock',
      content: [
        {
          type: 'table',
          content: [{ type: 'tableRow', content: held.map((content) => ({ type: 'tableCell', content })) }],
        },
        { type: 'tableCaption' },
      ],
    });
    /** Puts the cursor at the start of the paragraph that holds these words. */
    const at = (editor: Editor, written: string) => {
      let found = -1;
      editor.state.doc.descendants((node, pos) => {
        if (found < 0 && node.type.name === 'paragraph' && node.textContent === written) found = pos + 1;
      });
      editor.commands.setTextSelection(found);
    };
    /** The cursor, where it is one: the text of its block, and how far into it. */
    const cursor = (editor: Editor) => {
      const { empty, $from } = editor.state.selection;
      return empty ? `${$from.parent.textContent}@${$from.parentOffset}` : 'a range';
    };

    // The review of pull request 28, S3: the library selects all a cell holds,
    // and one letter then left a table of one cell with that letter in it.
    it('Tab and Shift+Tab into a cell that holds a table select nothing: the cursor goes to the cell’s own text, and a letter replaces nothing', () => {
      const editor = editorOf(
        rowOf(
          [paragraph(words('plain'))],
          [one('first'), paragraph(words('own text'))],
          [paragraph(words('last'))],
          [one('alone')],
        ),
      );
      const whole = text(editor);
      at(editor, 'plain');
      expect(key(editor, 'Tab')).toBe(true);
      // In the cell's own text, after the table: the innermost table is still the one being moved through.
      expect(cursor(editor)).toBe('own text@0');
      expect(round(editor).filter((name) => name === 'table')).toHaveLength(1);
      type(editor, 'X');
      expect(text(editor)).toBe(whole.replace('own text', 'Xown text'));
      editor.view.dispatch(
        editor.state.tr.delete(editor.state.selection.from - 1, editor.state.selection.from),
      );
      // A cell of text is as the library leaves it: all of it selected.
      expect(key(editor, 'Tab')).toBe(true);
      expect(cursor(editor)).toBe('a range');
      expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe(
        'last',
      );
      // A cell that holds a table and no text of its own: the first text in it, and nothing selected.
      expect(key(editor, 'Tab')).toBe(true);
      expect(cursor(editor)).toBe('alone@0');
      type(editor, 'X');
      expect(text(editor)).toBe(whole.replace('alone', 'Xalone'));
      editor.view.dispatch(
        editor.state.tr.delete(editor.state.selection.from - 1, editor.state.selection.from),
      );
      // And backwards.
      at(editor, 'last');
      expect(key(editor, 'Tab', true)).toBe(true);
      expect(cursor(editor)).toBe('own text@0');
      expect(text(editor)).toBe(whole);
    });

    // The review of pull request 28: a table pasted into an empty cell left
    // the cell with no place the keyboard reaches (WCAG 2.1.1).
    it('a table that a paste of the writer’s leaves at the end of a cell is followed by a paragraph, in the same step; no other cell is given one', () => {
      const held = (editor: Editor) => {
        const found: string[] = [];
        editor.state.doc.firstChild!.firstChild!.firstChild!.forEach((cell) =>
          found.push(cell.children.map(({ type }) => type.name).join(' ')),
        );
        return found;
      };
      const pasteOver = (editor: Editor, block: Json, meta: [string, unknown]) => {
        const { $from } = editor.state.selection;
        editor.view.dispatch(
          editor.state.tr
            .replaceWith($from.before(), $from.after(), editor.schema.nodeFromJSON(block))
            .setMeta(...meta),
        );
      };
      const editor = editorOf(rowOf([paragraph()], [paragraph(words('second'))], [paragraph()]));
      pasteOver(editor, one('pasted'), ['paste', true]);
      expect(held(editor)).toEqual(['tableBlock paragraph', 'paragraph', 'paragraph']);
      editor.state.doc.check();
      // A drop is one too. And a table put there by anything else is left as it is.
      at(editor, '');
      at(editor, 'second');
      pasteOver(editor, one('dropped'), ['uiEvent', 'drop']);
      expect(held(editor)).toEqual(['tableBlock paragraph', 'tableBlock paragraph', 'paragraph']);

      // Another client's cell that holds a table alone is not added to: not
      // when it arrives, and not when the writer pastes somewhere else.
      const theirs = editorOf(rowOf([paragraph()], [paragraph(words('second'))]));
      peer(theirs, [rowOf([one('theirs')], [paragraph(words('second'))])], 1);
      expect(held(theirs)).toEqual(['tableBlock', 'paragraph']);
      at(theirs, 'second');
      theirs.view.dispatch(theirs.state.tr.insertText('pasted ').setMeta('paste', true));
      expect(text(theirs)).toContain('pasted second');
      expect(held(theirs)).toEqual(['tableBlock', 'paragraph']);
      // But what the writer pastes INSIDE that table changes the table, and
      // the cell is then given its paragraph: the writer's own change, in that
      // cell (the re-review of pull request 28; kept, and said in the comment).
      at(theirs, 'theirs');
      theirs.view.dispatch(theirs.state.tr.insertText('pasted in ').setMeta('paste', true));
      expect(text(theirs)).toContain('pasted in theirs');
      expect(held(theirs)).toEqual(['tableBlock paragraph', 'paragraph']);
    });
  });
});

describe('the prompt of an empty document (the owner’s decision of 12 October 2026)', () => {
  // The owner's sentence, written out here and not taken from the code under test.
  const SENTENCE = 'Write here, or type / for a list of blocks.';
  type Drawn = { from: number; type: { toDOM: (view: unknown) => { attributes: Record<string, string> } } };
  /** The decorations that carry a prompt, from whichever plugin draws one. */
  function prompts(editor: Editor): Drawn[] {
    return editor.state.plugins.flatMap((plugin) => {
      const set = plugin.props.decorations?.call(plugin, editor.state) as
        { find(): unknown[] } | null | undefined;
      return ((set?.find() ?? []) as (Drawn & { type: { attrs?: Record<string, string> } })[]).filter(
        (each) => typeof each.type.toDOM === 'function' || each.type.attrs?.['data-placeholder'],
      );
    });
  }
  // An element as far as the prompt is made: its name and its attributes.
  const page = {
    dom: {
      ownerDocument: {
        createElement: (name: string) => {
          const attributes: Record<string, string> = { name };
          return { attributes, setAttribute: (key: string, value: string) => (attributes[key] = value) };
        },
      },
    },
  };

  it('is the one sentence, in an element hidden from a screen reader, in the empty paragraph', () => {
    const editor = editorOf();
    const [prompt, ...more] = prompts(editor);
    expect(more).toEqual([]);
    expect(prompt!.from).toBe(1);
    expect(prompt!.type.toDOM(page).attributes).toStrictEqual({
      name: 'span',
      'aria-hidden': 'true',
      'data-placeholder': SENTENCE,
    });
    // No content: the document holds an empty paragraph and nothing else.
    expect(json(editor)).toEqual([paragraph()]);
    expect(editor.getText()).toBe('');
  });

  it('goes at the first character, and is in no document but the empty one', () => {
    const editor = editorOf();
    type(editor, 'a');
    expect(prompts(editor)).toEqual([]);
    editor.view.dispatch(editor.state.tr.delete(1, 2));
    expect(prompts(editor)).toHaveLength(1);
    for (const content of [
      [paragraph(), paragraph()],
      [{ type: 'heading', attrs: { level: 1 } }],
      [{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph()] }] }],
      [paragraph({ type: 'hardBreak' })],
    ]) {
      expect(prompts(editorOf(...content)), JSON.stringify(content)).toEqual([]);
    }
    // An empty block that is no paragraph, alone. The editor follows such a
    // block with a paragraph, so the plugin is handed a document it would not make.
    const plugin = editor.state.plugins.find((each) =>
      (each.props.decorations?.call(each, editor.state) as { find(): Drawn[] } | null | undefined)
        ?.find()
        .some(({ type }) => typeof type.toDOM === 'function'),
    )!;
    const alone = (block: Json) =>
      plugin.props.decorations!.call(plugin, {
        doc: editor.schema.nodeFromJSON({ type: 'doc', content: [block] }),
      } as typeof editor.state);
    expect(alone(paragraph())).not.toBeNull();
    expect(alone({ type: 'heading', attrs: { level: 1 } })).toBeNull();
    expect(alone({ type: 'codeBlock', attrs: { language: 'plaintext' } })).toBeNull();
  });

  it('is not shown in a document that cannot be edited (FR-ED-18)', () => {
    const editor = editorOf();
    editor.setEditable(false);
    expect(prompts(editor)).toEqual([]);
    editor.setEditable(true);
    expect(prompts(editor)).toHaveLength(1);
  });
});

describe('the time the matcher takes', () => {
  // The pattern is linear in the line. A pattern with a quantifier inside a
  // quantifier would take seconds on these: this fails long before that.
  it.each([
    ['slashes', '/'.repeat(100_000)],
    ['a slash after each space', ' /'.repeat(50_000)],
    ['one long command', `/${'a'.repeat(100_000)}`],
    ['spaces, then a command', `${' '.repeat(100_000)}/h`],
    ['a command, then letters and a slash', `x /h${'a'.repeat(100_000)}/`],
  ])('reads a line of 100 KB of %s in a few milliseconds', (_, line) => {
    const editor = editorOf(paragraph(words(line)));
    const at = performance.now();
    for (const cursor of [1, 5, 50_000, line.length + 1]) {
      slashQuery(editor.state.doc.resolve(cursor));
    }
    expect(performance.now() - at).toBeLessThan(250);
  });
});

// The owner's decision R44 of 12 October 2026: nothing is said after a block
// is chosen. `closed` is what the list is given for the package's prop of
// that name: left alone it says "List closed.", and empty it says nothing.
describe('what the closing of the list says (R44; NFR-IC-19)', () => {
  const closing = (editor: Editor) => {
    const { open, closed } = slashPalette(editor.state);
    return open ? 'open' : closed;
  };

  it('is left to the package when the list is dismissed, by any means', () => {
    const dismissals: [string, (editor: Editor) => unknown][] = [
      ['Escape', (editor) => press(editor, 'Escape')],
      ['Tab', (editor) => press(editor, 'Tab')],
      ['the cursor leaving', (editor) => editor.commands.setTextSelection(1)],
      ['a second slash', (editor) => type(editor, '/')],
      ['another client rewriting the command', (editor) => peer(editor, [paragraph(words('/ta'))], 4)],
      [
        // Marked as ProseMirror marks what a plugin appends.
        'an appended transaction that ends the command',
        (editor) => {
          const tr = editor.state.tr.insertText('/');
          editor.view.dispatch(tr.setMeta('appendedTransaction', tr));
        },
      ],
    ];
    for (const [name, dismiss] of dismissals) {
      const editor = editorOf();
      expect(closing(editor), name).toBeUndefined();
      type(editor, '/h');
      expect(closing(editor), name).toBe('open');
      dismiss(editor);
      expect(closing(editor), name).toBeUndefined();
    }
  });

  it.each(ALL)('is empty after /%s is chosen, with Enter and with a press on its row', (name) => {
    const entered = editorOf();
    type(entered, `/${name}`);
    expect(press(entered, 'Enter')).toBe(true);
    // Through what a plugin appends to the choice too: the paragraph kept at the end of the document.
    expect(closing(entered)).toBe('');

    const pressed = editorOf();
    type(pressed, '/');
    chooseSlashCommand(pressed, name);
    expect(closing(pressed)).toBe('');
  });

  it('is empty until the list next opens, and a dismissal of that list is left to the package again', () => {
    const editor = editorOf();
    type(editor, '/h1');
    press(editor, 'Enter');
    expect(closing(editor)).toBe('');
    // Closed, nothing reads it: it stays through the writer's text and another client's change.
    type(editor, 'Title');
    peer(editor, [{ type: 'heading', attrs: { level: 1 }, content: [words('Title')] }, paragraph()], 6);
    expect(closing(editor)).toBe('');
    type(editor, ' /');
    expect(closing(editor)).toBe('open');
    press(editor, 'Escape');
    expect(closing(editor)).toBeUndefined();
  });

  it('is not set by a choice that is not made: a row that is not listed', () => {
    const editor = editorOf();
    type(editor, '/h');
    chooseSlashCommand(editor, 'table');
    expect(closing(editor)).toBe('open');
    press(editor, 'Escape');
    expect(closing(editor)).toBeUndefined();
  });
});
