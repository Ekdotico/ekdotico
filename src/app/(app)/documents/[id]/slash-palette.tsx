// The slash command palette (FR-ED-10, FR-ED-11, FR-ED-12): where it opens,
// what it lists, which keys are its own, and what choosing a row does. Its
// rows and its filter are src/lib/editor/slash-commands.ts.
//
// It is built on the library's own utility, `@tiptap/suggestion` (the owner's
// decision E1), and drawn by the design package's `OptionList` and by nothing
// of the application's (FR-AU-88). The utility's positioning of a list, which
// is what brings `@floating-ui/dom` with it, is not used: the control places
// itself.
//
// The focus never leaves the text, so the list takes no key and holds no
// state. Everything is in the state of the editor: the utility's plugin says
// whether there is a command at the cursor, and a second plugin here says
// which row is marked and whether the writer is moving in the list. The
// component at the end of the file draws that state and changes none of it
// but through a transaction.
//
// A choice is a change of the document like any other, so the document's own
// rules hold it: it is not applied while the document cannot be edited
// (`mayApply`), and it makes nothing the schema does not take (`closeSchema`,
// both of ./extensions.tsx).
'use client';

import { Extension, type Editor, type Range } from '@tiptap/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { useEditorState } from '@tiptap/react';
import { exitSuggestion, Suggestion } from '@tiptap/suggestion';
import { ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
import {
  OptionList,
  optionListAttributes,
  optionListKey,
  optionListNavigating,
  type OptionListItem,
  type OptionListKeyEvent,
} from '@ekdotico/domico/components';
import {
  matchSlashCommands,
  SLASH_COMMANDS,
  type Block,
  type SlashCommand,
} from '../../../../lib/editor/slash-commands.ts';
import { limitRefusal, passesLimits } from './block-limits.ts';
import { insertingFootnote, LIST } from './footnotes.ts';
import { tableRoom, tablesIn } from './table-bounds.ts';

/** The id of the list, which the text names while the list shows a row. */
export const SLASH_LIST_ID = 'slash-commands';

// FR-ED-11: "a maximum of eight results at a time and shall be scrollable".
const MOST_SHOWN = 8;

// FR-ED-12 gives each command and not a name for its row, and no requirement
// gives the three texts under the names. Written under the Expression
// Guidelines; the owner approves them with the pull request (the answer to Q6
// of the plan).
export const SLASH_NAMES: Record<string, string> = {
  text: 'Text',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  bullet: 'Bulleted list',
  numbered: 'Numbered list',
  quote: 'Quote',
  table: 'Table',
  code: 'Code block',
  image: 'Image',
  callout: 'Callout',
  footnote: 'Footnote',
  toc: 'Table of contents',
  divider: 'Divider',
  'page-break': 'Page break',
};
const LIST_NAME = 'Blocks';
const NO_MATCH = 'No block matches. Delete a letter to see more.';
/** The count, and the row Enter chooses while nothing has been moved (the package, "The option list"). */
const counted = (rows: readonly OptionListItem[]) =>
  rows[0] ? `${rows.length === 1 ? '1 block' : `${rows.length} blocks`}. ${rows[0].label} first.` : '';

/** What the utility's plugin holds, as far as this file reads it. */
interface Suggesting {
  active: boolean;
  range: Range;
  query: string | null;
  text: string | null;
}
const SLASH = new PluginKey<Suggesting>('slashPalette');

/** A command as it stood: where its `/` was, its text, and the blocks it stood in. */
interface Command {
  from: number;
  text: string;
  within: string;
}
/** The blocks round a place, from the document inwards, by the names of their types. */
const within = ($at: ResolvedPos) =>
  Array.from({ length: $at.depth + 1 }, (_, depth) => $at.node(depth).type.name).join(' ');

/**
 * What this file holds beside the library's plugin: the row the writer has
 * moved to, and whether the last key was a move in the list.
 */
interface Held {
  activeId: string | null;
  navigating: boolean;
}
const HELD = new PluginKey<Held>('slashPaletteHeld');
const STILL: Held = { activeId: null, navigating: false };

/**
 * Whether the list is closed and it was a choice that closed it (the owner's
 * decision R44 of 12 October 2026: nothing is said after a block is chosen;
 * NFR-IC-19). `chooseSlashCommand` marks its transaction with this key and
 * nothing else does, so another client's change and what a plugin appends
 * never set it. It is held in the state of the editor, beside `open`, because
 * the package reads `closed` on the one render in which `open` becomes false:
 * the two must come from the same state. It is put back when the list next
 * opens, so a list that Escape then closes is said to have closed.
 */
const CHOSEN = new PluginKey<boolean>('slashPaletteChosen');

/**
 * FR-ED-10: the command at the cursor, where there is one: a `/` "at the
 * beginning of an empty block or following a space character", and the whole
 * word it begins, to the next white space or the end of the block, wherever
 * in that word the cursor stands. So the filter is what the writer sees after
 * the slash, and a choice replaces all of it. At the beginning, the command is
 * all the block holds. Never in code, which is text as it is typed.
 *
 * The block's own text is read, and not the one run of text before the
 * cursor, which is what the library's own function reads: a `/` typed after
 * a word in bold follows that word and no space.
 */
export function slashQuery($cursor: ResolvedPos): { range: Range; query: string; text: string } | null {
  const block = $cursor.parent;
  if (!block.isTextblock || block.type.spec.code) return null;
  // A node that is not text, a line break, stands as one character that is neither a space nor a letter.
  const before = block.textBetween(0, $cursor.parentOffset, undefined, '\n');
  const found = /(^| )\/(\S*)$/.exec(before);
  if (!found) return null;
  const after = /^\S*/.exec(block.textBetween($cursor.parentOffset, block.content.size, undefined, '\n'))![0];
  const query = found[2]! + after;
  // A second slash ends the command: an address or a path is not one.
  if (query.includes('/')) return null;
  if (found[1] === '' && block.content.size !== query.length + 1) return null;
  const from = $cursor.pos - found[2]!.length - 1;
  return { range: { from, to: from + query.length + 1 }, query, text: `/${query}` };
}

/**
 * Whether the command a transaction leaves at the cursor is the one that
 * stood before it. By where its `/` is, for a change of this writer's. The
 * collaboration binding applies every change of another client, and every
 * undo, as one replacement of the whole document, through which no place
 * maps, and puts the cursor back where it was: there the command is known by
 * its text and by the kinds of block it stands in, so a change elsewhere in
 * the document leaves it, and a change to the command itself, or one that
 * puts it in another kind of block, does not. (Another client that takes the
 * command away and writes the same text in the same kind of block is not
 * told apart: the list the writer opened stays open on that text.)
 */
function same(transaction: Transaction, was: Command, range: Range, text: string): boolean {
  return transaction.getMeta(ySyncPluginKey)
    ? was.text === text && was.within === within(transaction.doc.resolve(range.from))
    : transaction.mapping.map(was.from) === range.from;
}

/** Whether the command is all its block holds: the block is then replaced, and otherwise the new block follows it. */
const alone = ($from: ResolvedPos, range: Range) => range.from === $from.start() && range.to === $from.end();

/**
 * Whether the block of a row can stand where the command is: in place of the
 * block the command is alone in, or after the block it was typed in. A row
 * whose block cannot stand there is not listed, and where no row can, as in
 * the caption of a table, the palette does not open.
 *
 * A table stands in a cell of a table (the owner's decision R32 of 12 October
 * 2026), for as long as the tables are inside the bounds they share: the row
 * is not listed in a cell of the deepest table there may be, nor where the
 * outermost table has no room for the cells of a new one (./table-bounds.ts).
 * Nor a block that would pass a limit of the document: a type at its limit,
 * or a list that would stand too deep (D182, D192; ./block-limits.ts).
 */
function stands(state: EditorState, range: Range, block: Block): boolean {
  const $from = state.doc.resolve(range.from);
  const type = state.schema.nodes[block.type]!;
  if (type.name === 'tableBlock') {
    const room = tableRoom($from);
    const made = state.schema.nodeFromJSON(block);
    const brings = tablesIn(made);
    if (brings.levels > room.levels || brings.cells > room.cells) return false;
  }
  const index = $from.index(-1);
  const fits = alone($from, range)
    ? $from.node(-1).canReplaceWith(index, index + 1, type)
    : $from.node(-1).canReplaceWith(index + 1, index + 1, type);
  if (!fits) return false;
  // The block itself at its limit (at the total, nothing is listed), and the
  // change as it would be made, with the paragraph that may follow the block
  // (the review of pull request 42: a divider at 4,999 brought 5,001).
  const node = state.schema.nodeFromJSON(block);
  return (
    !passesLimits(state.doc, node, $from) && limitRefusal(putting(state, range, node), state.doc) === null
  );
}

/**
 * Whether a footnote can be put where the command stands (FR-ED-05): a marker can stand there (not in a
 * code block, a caption or an entry), and the change, with the entry it makes, keeps the limits of the
 * document: the entry is a block of the 5,000.
 */
function standsFootnote(state: EditorState, range: Range): boolean {
  const tr = insertingFootnote(state, range);
  return tr !== null && limitRefusal(tr, state.doc) === null;
}

const offered = (state: EditorState, range: Range, commands: readonly SlashCommand[]) =>
  commands.filter(({ inserts, action }) =>
    action === 'footnote' ? standsFootnote(state, range) : stands(state, range, inserts),
  );

/**
 * Whether a transaction is a request for the palette: this writer typed the
 * `/` of the command in it, and nothing else asks (the owner's decision of
 * 12 October 2026). The transaction is the writer's own, puts in the one
 * character `/` and nothing with it, where the command now begins, and is
 * not a paste or a drop, nor made while an input method is composing.
 * Another client's change and an undo or a redo arrive from the collaboration
 * binding, and are none of these.
 *
 * So a `/` that was pasted, that another client put in, that an undo brought
 * back, or that was in the text already opens nothing, whatever is typed
 * after it: another client could otherwise put a `/` before the word a writer
 * is typing, and the writer's next letter would open the list on a row that
 * Enter then puts in place of the word. The package's README reads typing in
 * a word that begins with a `/` as a request ("typing in that word is"); the
 * decision overrides it here.
 *
 * Nothing remembers whose a `/` is but the open list itself: the list stays
 * open for as long as the cursor stays in the command it was opened on
 * (`same`), and once closed, by any means, that `/` does not open it again.
 * To ask again the writer types a `/` again.
 */
export function typesSlash(transaction: Transaction, range: Range, composing: boolean): boolean {
  if (!transaction.docChanged || composing || transaction.getMeta(ySyncPluginKey)) return false;
  // ProseMirror marks what it pastes and what it drops.
  if (transaction.getMeta('paste') || transaction.getMeta('uiEvent')) return false;
  return transaction.steps.some((step, index) => {
    if (!(step instanceof ReplaceStep)) return false;
    const { content } = step.slice;
    return (
      content.childCount === 1 &&
      content.firstChild!.text === '/' &&
      transaction.mapping.slice(index + 1).map(step.from) === range.from
    );
  });
}

const CLOSED = {
  open: false,
  options: [] as OptionListItem[],
  activeId: null as string | null,
  navigating: false,
  range: { from: 0, to: 0 } as Range,
  /** The package's `closed`: left alone, "List closed."; empty, nothing is said. */
  closed: undefined as '' | undefined,
};
/** Closed by a choice: nothing is said of the closing (R44). */
const CLOSED_BY_CHOICE: typeof CLOSED = { ...CLOSED, closed: '' };

/** The palette as the state of the editor holds it: what the list draws and what the keys act on. */
export function slashPalette(state: EditorState): typeof CLOSED {
  const suggesting = SLASH.getState(state);
  if (!suggesting?.active) return CHOSEN.getState(state) ? CLOSED_BY_CHOICE : CLOSED;
  const { range } = suggesting;
  const options = offered(state, range, matchSlashCommands(suggesting.query ?? '')).map(({ name }) => ({
    id: name,
    label: SLASH_NAMES[name]!,
    detail: `/${name}`,
  }));
  const moving = HELD.getState(state) ?? STILL;
  // The first match is marked unless the writer has moved to another that is still listed.
  const activeId = options.some(({ id }) => id === moving.activeId)
    ? moving.activeId
    : (options[0]?.id ?? null);
  return { open: true, options, activeId, navigating: moving.navigating, range, closed: undefined };
}

/** Closes the palette. The `/` and what follows it stay as text, and the list stays closed for that `/`. */
export function closeSlashPalette(editor: Editor): void {
  if (SLASH.getState(editor.state)?.active) exitSuggestion(editor.view, SLASH);
}

/**
 * The "Insert" control's way to the palette (ui-dc-insert): it types, for the writer, the `/` that opens
 * it, where the cursor stands, and so it is the same palette with the same rules (FR-ED-10), the same
 * list, and the same choice. The `/` goes where a typed one may: alone in an empty block, or after a
 * space, which is added where the cursor follows a character that is not one. Where the rules would not
 * open the palette there (a block that holds text, the cursor at its start), nothing is left behind and
 * false is returned.
 */
export function openSlashPalette(editor: Editor): boolean {
  if (!editor.isEditable) return false;
  // At once, and not by the library's `focus` command, which gives the focus a frame later (it waits for
  // `requestAnimationFrame`) and scrolls: the palette is opened on this same turn, as a typed `/` opens it.
  // Only where a view is mounted: before that (a test's editor) there is none to give the focus to, and the
  // library's view then throws on `focus`.
  if (editor.isInitialized) editor.view.focus();
  const { state } = editor;
  const at = state.selection.to;
  const $at = state.doc.resolve(at);
  if (!$at.parent.isTextblock || $at.parent.type.spec.code) return false;
  const before = $at.parent.textBetween(Math.max(0, $at.parentOffset - 1), $at.parentOffset);
  const spaced = $at.parentOffset === 0 || /\s/u.test(before);
  const typed = spaced ? '/' : ' /';
  // A step of its own for the `/`, as a typed one is (`typesSlash`).
  const tr = state.tr;
  if (!spaced) tr.insertText(' ', at);
  tr.insertText('/', at + (spaced ? 0 : 1));
  editor.view.dispatch(tr);
  if (slashPalette(editor.state).open) return true;
  editor.view.dispatch(editor.state.tr.delete(at, at + typed.length));
  return false;
}

/**
 * Puts the block of a row where its command stands, in place of exactly the
 * `/` and what was typed after it, as one step of undo (the owner's decision
 * of 9 October 2026). Only a row that is listed is chosen.
 */
export function chooseSlashCommand(editor: Editor, name: string): void {
  const { state } = editor;
  const shown = slashPalette(state);
  const command = SLASH_COMMANDS.find((each) => each.name === name);
  if (!command || !shown.options.some(({ id }) => id === name)) return;
  if (command.action === 'image') {
    // FR-ED-08: the command's text goes, as a block's choice replaces it, and the picker opens; the
    // block follows the upload, in place of the empty paragraph the cursor is left in (`insertImageBlock`).
    (
      yUndoPluginKey.getState(state) as { undoManager?: { stopCapturing(): void } } | undefined
    )?.undoManager?.stopCapturing();
    editor.view.dispatch(state.tr.delete(shown.range.from, shown.range.to).setMeta(CHOSEN, true));
    // Absent where the editor was made without the upload (a reader's, a test's): nothing opens.
    editor.commands.chooseImage?.();
    return;
  }
  // FR-ED-05: the marker where the command stood, its entry, and the cursor in the entry: one change.
  const tr =
    command.action === 'footnote'
      ? insertingFootnote(state, shown.range)
      : putting(state, shown.range, state.schema.nodeFromJSON(command.inserts));
  if (!tr) return;
  // Undo joins what is typed within half a second into one step (FR-ED-16,
  // over Yjs). The choice begins a step of its own, so that undoing it leaves
  // the `/` and the query as they were typed.
  (
    yUndoPluginKey.getState(state) as { undoManager?: { stopCapturing(): void } } | undefined
  )?.undoManager?.stopCapturing();
  editor.view.dispatch(tr.setMeta(CHOSEN, true));
}

/** The change that puts a block where the command of `range` stands (`chooseSlashCommand`). */
function putting(state: EditorState, range: Range, node: PMNode): Transaction {
  const { from, to } = range;
  const $from = state.doc.resolve(from);
  const tr = state.tr;
  let at = from + 1;
  if (alone($from, range)) {
    at = $from.before();
    tr.replaceWith(at, $from.after(), node);
  } else {
    tr.delete(from, to);
    // What stood after the cursor follows the new block, in a block of its own.
    if (to < $from.end()) tr.split(from);
    tr.insert(at, node);
  }
  let cursor = at + 1;
  const $after = tr.doc.resolve(at + node.nodeSize);
  const paragraph = state.schema.nodes.paragraph!;
  const next = $after.nodeAfter;
  // A block that holds no text. The cursor goes after it, into text: a
  // block that is selected whole is replaced by the next letter typed. So
  // where no text follows, an empty paragraph does, as after the library's
  // own horizontal rule.
  //
  // And a table that ends the block it was put in is followed by one too
  // (R32): the arrow keys step from a table to the nearest text, so a cell
  // that held a table and nothing else could not be written in, and the menu
  // of the table round it could not be reached from that cell, by keyboard.
  // (At the end of the document the library puts the same paragraph itself.)
  // The list of footnotes at the end is not text to rest in: a block put last in the body is followed by a
  // paragraph, and the cursor does not go into an entry (W-11).
  const noText = !next || next.type.name === LIST;
  if (
    (node.isLeaf ? noText || next.isLeaf : noText && tablesIn(node).levels > 0) &&
    $after.parent.canReplaceWith($after.index(), $after.index(), paragraph)
  ) {
    tr.insert($after.pos, paragraph.create());
  }
  if (node.isLeaf) cursor = $after.pos;
  return tr.setSelection(Selection.near(tr.doc.resolve(cursor), 1)).scrollIntoView();
}

/**
 * A key pressed in the text while the palette is open, read as the package
 * reads it for every product (`optionListKey`). True where the key was the
 * list's, and the text does nothing with it. The library closes the palette
 * on Escape itself, after this.
 */
function key(editor: Editor, view: EditorView, event: OptionListKeyEvent): boolean {
  // Tab closes the list and then does what it does in the text: it leaves the
  // text, or indents a list item. A list of more than eight rows scrolls, and
  // Chromium makes a scroller a stop of Tab; the focus would go into the list,
  // which goes when the text loses the focus, and be left on nothing. (A
  // stopgap: the list itself should be no stop, which is the package's to say.)
  if (event.key === 'Tab') {
    closeSlashPalette(editor);
    return false;
  }
  const shown = slashPalette(view.state);
  const result = optionListKey(event, { ...shown, maxVisible: MOST_SHOWN });
  const navigating = optionListNavigating(event, result, shown.navigating);
  if (result && 'select' in result) {
    chooseSlashCommand(editor, result.select);
    return true;
  }
  const activeId = result && 'activeId' in result ? result.activeId : shown.activeId;
  if (activeId !== shown.activeId || navigating !== shown.navigating) {
    view.dispatch(view.state.tr.setMeta(HELD, { activeId, navigating } satisfies Held));
  }
  return result !== null;
}

/**
 * NFR-IC-19: what the text says of the list while it has the focus and the
 * list is open, as the package gives it. ProseMirror writes every key it is
 * handed, so one that is `undefined` is left out and not written as a word.
 */
export function slashAttributes(state: EditorState): Record<string, string> {
  const given = optionListAttributes(SLASH_LIST_ID, slashPalette(state));
  return Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
}

export const SlashPalette = Extension.create({
  name: 'slashPalette',
  // Before the keys of every block: while the list is open, Enter and the arrows are its own.
  priority: 1000,
  addProseMirrorPlugins() {
    const { editor } = this;
    // The command the list was open on in the state a transaction is applied
    // to, set by the first plugin below for the library's plugin, which is
    // handed the transaction and not that state. `editor.state` is not it:
    // through a dispatch it stays the state before the first transaction, so
    // for a transaction that a plugin appends (the paragraph kept at the end
    // of a document, the repair of a table) it still said "open" after
    // another client's change to the command had closed the list, and the
    // list opened again on what that client wrote.
    let open: Command | null = null;
    return [
      new Plugin({
        state: {
          init: () => null,
          apply(_transaction, _value, before) {
            const was = SLASH.getState(before);
            open = was?.active
              ? {
                  from: was.range.from,
                  text: was.text ?? '',
                  within: within(before.doc.resolve(was.range.from)),
                }
              : null;
            return null;
          },
        },
      }),
      // Inactive while the document cannot be edited (FR-ED-18): the library reads `isEditable` itself.
      Suggestion({
        pluginKey: SLASH,
        editor,
        char: '/',
        // The class is named by no stylesheet: the command is drawn as the text it is.
        decorationClass: 'slash-command',
        findSuggestionMatch: ({ $position }) => slashQuery($position),
        allow: ({ state, range }) => offered(state, range, SLASH_COMMANDS).length > 0,
        // Open already, on this `/`; or its `/` is typed now (`typesSlash`).
        // So a list that is closed stays closed for its `/`, however it was
        // closed: by Escape, by Tab, by a press outside, by the cursor
        // leaving, or by another client's change to the command.
        shouldShow: ({ range, text, transaction }) =>
          (open !== null && same(transaction, open, range, text)) ||
          typesSlash(transaction, range, editor.view.composing),
        // The library remembers a closed list too, by the place of its `/`,
        // which after another client's change is a place no command has. The
        // rule above is the whole rule: a `/` typed now is a new request.
        shouldResetDismissed: () => true,
        render: () => ({ onKeyDown: ({ view, event }) => key(editor, view, event) }),
      }),
      new Plugin<Held>({
        key: HELD,
        state: {
          init: () => STILL,
          apply(transaction, was) {
            const moved = transaction.getMeta(HELD) as Held | undefined;
            if (moved) return moved;
            // Text arrived or the cursor moved, with a key or without one: the
            // move in the list is over, and a new filter starts at its first
            // match. Another client's change is neither, and nor is what a
            // plugin appends to it.
            const own = !transaction.getMeta(ySyncPluginKey) && !transaction.getMeta('appendedTransaction');
            return own && (transaction.docChanged || transaction.selectionSet) ? STILL : was;
          },
        },
        props: { attributes: slashAttributes },
      }),
      // After the library's plugin, whose new state it reads: true from the
      // choice that closes the list until the list is open again.
      new Plugin<boolean>({
        key: CHOSEN,
        state: {
          init: () => false,
          apply: (transaction, was, _before, after) =>
            !SLASH.getState(after)?.active && (transaction.getMeta(CHOSEN) === true || was),
        },
      }),
    ];
  },
  // The list does not outlast the focus of the text, nor the editing (FR-ED-18).
  onBlur() {
    closeSlashPalette(this.editor);
  },
  onUpdate() {
    if (!this.editor.isEditable) closeSlashPalette(this.editor);
  },
});

/** The list of the palette, at the `/` of the command. It is given no focus and handles no key. */
export function SlashPaletteList({ editor }: { editor: Editor }) {
  const shown = useEditorState({ editor, selector: ({ editor: current }) => slashPalette(current.state) });
  return (
    <OptionList
      id={SLASH_LIST_ID}
      label={LIST_NAME}
      open={shown.open}
      options={shown.options}
      activeId={shown.activeId}
      maxVisible={MOST_SHOWN}
      empty={NO_MATCH}
      status={counted(shown.options)}
      // Said when the list closes: the package's "List closed.", and nothing after a choice (R44).
      closed={shown.closed}
      // The pointer moved onto a row: marked, and no move by key.
      onActiveChange={(activeId) =>
        editor.view.dispatch(
          editor.state.tr.setMeta(HELD, { activeId, navigating: shown.navigating } satisfies Held),
        )
      }
      onSelect={(name) => chooseSlashCommand(editor, name)}
      // FR-ED-10: "or clicks outside it".
      onDismiss={() => closeSlashPalette(editor)}
      // The `/`, and not the cursor, so that the list stays where it is while the query is typed.
      anchor={() => {
        const { open, range } = slashPalette(editor.state);
        if (!open) return null;
        const at = editor.view.coordsAtPos(range.from);
        return { x: at.left, y: at.top, width: at.right - at.left, height: at.bottom - at.top };
      }}
    />
  );
}
