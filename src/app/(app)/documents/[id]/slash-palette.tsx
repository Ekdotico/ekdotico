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
import type { NodeType, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from '@tiptap/pm/state';
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
  type SlashCommand,
} from '../../../../lib/editor/slash-commands.ts';

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
  callout: 'Callout',
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

/** A command as it stood: where its `/` was, and its text. */
interface Command {
  from: number;
  text: string;
}

/**
 * What this file holds beside the library's plugin: the row the writer has
 * moved to, whether the last key was a move in the list, and the command the
 * writer closed the list on, for as long as the cursor stays in it.
 */
interface Held {
  activeId: string | null;
  navigating: boolean;
  dismissed: Command | null;
}
const HELD = new PluginKey<Held>('slashPaletteHeld');
type Moving = Pick<Held, 'activeId' | 'navigating'>;
const STILL: Moving = { activeId: null, navigating: false };

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
 * its text, so a change elsewhere in the document leaves it, and a change to
 * the command itself does not.
 */
function same(transaction: Transaction, was: Command, range: Range, text: string): boolean {
  return transaction.getMeta(ySyncPluginKey)
    ? was.text === text
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
 * A table does not stand inside a table: no requirement provides for one in
 * a cell (FR-ED-09), though the schema would hold it. Reported for the
 * register.
 */
function stands(state: EditorState, range: Range, type: NodeType): boolean {
  const $from = state.doc.resolve(range.from);
  if (type.name === 'tableBlock') {
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === 'tableBlock') return false;
    }
  }
  const index = $from.index(-1);
  return alone($from, range)
    ? $from.node(-1).canReplaceWith(index, index + 1, type)
    : $from.node(-1).canReplaceWith(index + 1, index + 1, type);
}

const offered = (state: EditorState, range: Range, commands: readonly SlashCommand[]) =>
  commands.filter(({ inserts }) => stands(state, range, state.schema.nodes[inserts.type]!));

/**
 * Whether a transaction is a request for the palette: this writer's own
 * change to the text of the command, and not while an input method is
 * composing. A cursor that arrives after a `/` already in the text is no
 * request, and neither is another client's change, nor an undo.
 */
export function opens(transaction: Transaction, range: Range, composing: boolean): boolean {
  if (!transaction.docChanged || composing || transaction.getMeta(ySyncPluginKey)) return false;
  const { maps } = transaction.mapping;
  return maps.some((map, index) => {
    let touched = false;
    const later = transaction.mapping.slice(index + 1);
    map.forEach((_from, _to, start, end) => {
      if (later.map(start, -1) <= range.to && later.map(end, 1) >= range.from) touched = true;
    });
    return touched;
  });
}

const CLOSED = {
  open: false,
  options: [] as OptionListItem[],
  activeId: null as string | null,
  navigating: false,
  range: { from: 0, to: 0 } as Range,
};

/** The palette as the state of the editor holds it: what the list draws and what the keys act on. */
export function slashPalette(state: EditorState): typeof CLOSED {
  const suggesting = SLASH.getState(state);
  if (!suggesting?.active) return CLOSED;
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
  return { open: true, options, activeId, navigating: moving.navigating, range };
}

/** Closes the palette. The `/` and what follows it stay as text, and the list stays closed for that `/`. */
export function closeSlashPalette(editor: Editor): void {
  if (SLASH.getState(editor.state)?.active) exitSuggestion(editor.view, SLASH);
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
  const { from, to } = shown.range;
  const $from = state.doc.resolve(from);
  const node = state.schema.nodeFromJSON(command.inserts);
  const tr = state.tr;
  let at = from + 1;
  if (alone($from, shown.range)) {
    at = $from.before();
    tr.replaceWith(at, $from.after(), node);
  } else {
    tr.delete(from, to);
    // What stood after the cursor follows the new block, in a block of its own.
    if (to < $from.end()) tr.split(from);
    tr.insert(at, node);
  }
  let cursor = at + 1;
  if (node.isLeaf) {
    // A block that holds no text. The cursor goes after it, into text: a
    // block that is selected whole is replaced by the next letter typed. So
    // where no text follows, an empty paragraph does, as after the library's
    // own horizontal rule.
    cursor = at + node.nodeSize;
    const $after = tr.doc.resolve(cursor);
    const paragraph = state.schema.nodes.paragraph!;
    const next = $after.nodeAfter;
    if ((!next || next.isLeaf) && $after.parent.canReplaceWith($after.index(), $after.index(), paragraph)) {
      tr.insert(cursor, paragraph.create());
    }
  }
  tr.setSelection(Selection.near(tr.doc.resolve(cursor), 1)).scrollIntoView();
  // Undo joins what is typed within half a second into one step (FR-ED-16,
  // over Yjs). The choice begins a step of its own, so that undoing it leaves
  // the `/` and the query as they were typed.
  (
    yUndoPluginKey.getState(state) as { undoManager?: { stopCapturing(): void } } | undefined
  )?.undoManager?.stopCapturing();
  editor.view.dispatch(tr);
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
    view.dispatch(view.state.tr.setMeta(HELD, { activeId, navigating } satisfies Moving));
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
    return [
      // Inactive while the document cannot be edited (FR-ED-18): the library reads `isEditable` itself.
      Suggestion({
        pluginKey: SLASH,
        editor,
        char: '/',
        // The class is named by no stylesheet: the command is drawn as the text it is.
        decorationClass: 'slash-command',
        findSuggestionMatch: ({ $position }) => slashQuery($position),
        allow: ({ state, range }) => offered(state, range, SLASH_COMMANDS).length > 0,
        // Not on the `/` the writer closed the list on. Otherwise: open
        // already, on this `/`; or asked for now. The states read here are
        // those before the whole dispatch, so a transaction a plugin appends
        // to one that opened the list would close it; nothing appends one to
        // typing in a command. (The library remembers a closed list too, by
        // the place of its `/`: it agrees with this for the writer's own
        // changes, and after another client's it holds a place no command has.)
        shouldShow: ({ range, text, transaction }) => {
          const was = SLASH.getState(editor.state);
          const dismissed = HELD.getState(editor.state)?.dismissed;
          if (dismissed && same(transaction, dismissed, range, text)) return false;
          return (
            (was?.active === true &&
              same(transaction, { from: was.range.from, text: was.text ?? '' }, range, text)) ||
            opens(transaction, range, editor.view.composing)
          );
        },
        render: () => ({ onKeyDown: ({ view, event }) => key(editor, view, event) }),
      }),
      new Plugin<Held>({
        key: HELD,
        state: {
          init: () => ({ ...STILL, dismissed: null }),
          apply(transaction, was, before, state) {
            let { dismissed } = was;
            const suggesting = SLASH.getState(before);
            if ((transaction.getMeta(SLASH) as { exit?: boolean } | undefined)?.exit) {
              // Closed by the writer: by Escape, a press outside, Tab, or the loss of the focus.
              if (suggesting?.active)
                dismissed = { from: suggesting.range.from, text: suggesting.text ?? '' };
            } else if (dismissed) {
              // Until the cursor leaves the command, or the command is another.
              const now = state.selection.empty ? slashQuery(state.selection.$from) : null;
              dismissed =
                now && same(transaction, dismissed, now.range, now.text)
                  ? { from: now.range.from, text: now.text }
                  : null;
            }
            const moved = transaction.getMeta(HELD) as Moving | undefined;
            if (moved) return { ...moved, dismissed };
            // Text arrived or the cursor moved, with a key or without one: the
            // move in the list is over, and a new filter starts at its first
            // match. Another client's change is neither.
            const own = !transaction.getMeta(ySyncPluginKey);
            const moving = own && (transaction.docChanged || transaction.selectionSet) ? STILL : was;
            return { activeId: moving.activeId, navigating: moving.navigating, dismissed };
          },
        },
        props: { attributes: slashAttributes },
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
      // The pointer moved onto a row: marked, and no move by key.
      onActiveChange={(activeId) =>
        editor.view.dispatch(
          editor.state.tr.setMeta(HELD, { activeId, navigating: shown.navigating } satisfies Moving),
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
