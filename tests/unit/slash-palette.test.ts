// The slash command palette (FR-ED-10 to FR-ED-12) as the state of the editor
// holds it: where it opens, what it lists, its keys, and what a choice does
// to the document. tests/e2e/editor.spec.ts presses the keys in a browser,
// where the list is drawn and undo has a document to undo in.
import { Editor, type JSONContent } from '@tiptap/core';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { optionListOptionId } from '@ekdotico/domico/components';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import {
  chooseSlashCommand,
  opens,
  slashAttributes,
  SLASH_LIST_ID,
  SLASH_NAMES,
  slashPalette,
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

  it('does not open for a cursor that arrives after a slash already in the text, and does once that word is typed in', () => {
    const editor = editorOf(paragraph(words('/h')), paragraph());
    editor.commands.setTextSelection(3);
    expect(slashPalette(editor.state).open).toBe(false);
    type(editor, '1');
    expect(listed(editor)).toEqual(['h1']);
    // And it closes when the cursor leaves the command.
    editor.commands.setTextSelection(6);
    expect(slashPalette(editor.state).open).toBe(false);
  });

  it('is asked for by this writer’s own change to the command, and by nothing else', () => {
    const editor = editorOf(paragraph(words('/h')), paragraph(words('far')));
    const range = { from: 1, to: 3 };
    const typed = () => editor.state.tr.insertText('1', 3);
    expect(opens(typed(), { from: 1, to: 4 }, false)).toBe(true);
    // An input method that is composing has not committed what it shows.
    expect(opens(typed(), { from: 1, to: 4 }, true)).toBe(false);
    // Another client's change, and an undo, arrive from the collaboration binding.
    expect(opens(typed().setMeta(ySyncPluginKey, { isChangeOrigin: true }), { from: 1, to: 4 }, false)).toBe(
      false,
    );
    // A change elsewhere in the document, and a move of the cursor.
    expect(opens(editor.state.tr.insertText('!', 8), range, false)).toBe(false);
    expect(opens(editor.state.tr.setMeta('moved', true), range, false)).toBe(false);
  });

  it('stays as it is through another client’s change, at the row the writer moved to', () => {
    const editor = editorOf(paragraph(words('above')), paragraph());
    editor.commands.setTextSelection(8);
    type(editor, '/h');
    press(editor, 'ArrowDown');
    expect(slashPalette(editor.state).activeId).toBe('h2');
    editor.view.dispatch(
      editor.state.tr.insertText('More ', 1).setMeta(ySyncPluginKey, { isChangeOrigin: true }),
    );
    const shown = slashPalette(editor.state);
    expect(shown).toMatchObject({
      open: true,
      activeId: 'h2',
      navigating: true,
      range: { from: 13, to: 15 },
    });
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
    for (const each of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab', 'Backspace', 'a']) {
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
