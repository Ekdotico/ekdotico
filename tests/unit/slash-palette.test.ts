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

  it('lists no table inside a table, in a cell or in a block in a cell (FR-ED-09 provides for none)', () => {
    const table = SLASH_COMMANDS.find(({ name }) => name === 'table')!.inserts;
    const editor = editorOf(table);
    const others = ALL.filter((name) => name !== 'table');
    type(editor, '/');
    expect(listed(editor)).toEqual(others);
    chooseSlashCommand(editor, 'table');
    expect(text(editor)).toBe('/');
    type(editor, 'table');
    expect(slashPalette(editor.state)).toMatchObject({ open: true, options: [] });
    expect(press(editor, 'Enter')).toBe(false);
    // In a quotation in the cell.
    editor.view.dispatch(editor.state.tr.delete(2, 7));
    type(editor, 'quote');
    press(editor, 'Enter');
    type(editor, 'Quoted /');
    expect(listed(editor)).toEqual(others);
    let tables = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'table') tables += 1;
    });
    expect(tables).toBe(1);
  });
});

describe('the prompt of an empty document (the owner’s decision of 12 October 2026)', () => {
  // The owner's sentence, written out here and not taken from the code under test.
  const SENTENCE = 'Type / for a list of blocks.';
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
