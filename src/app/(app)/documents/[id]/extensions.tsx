// What a document may hold (FR-ED-01, FR-ED-02, as far as the cut and this
// slice go): the blocks, the nine marks, and the controls each block carries
// inside itself (the owner's decision E3 of 8 October 2026). Images and
// footnotes join with their own slices; the LaTeX block, the Mermaid block and
// the citation node are not in α 0.1.0.
//
// THE SCHEMA IS THE SANITISER (NFR-SE-06, A03). Nothing here renders markup
// that a document or a clipboard supplied: a paste and a change from another
// client both become nodes of this schema or nothing, there is no node for
// raw HTML, and the one attribute that a browser acts on, the address of a
// link, is held to src/lib/editor/link.ts.
//
// The collaboration server holds a document to its size and its depth and
// reads nothing else of it (src/lib/collab/state.ts), so every attribute of
// every node and mark that arrives is hostile, whatever its type. Each
// attribute the schema defines has one rule in `ATTRIBUTE_RULES` below, a
// closed list or a bounded number, and the rule is applied where the schema
// makes a node or a mark (`closeSchema`): a plugin, a node view and
// `renderHTML` are all handed the value the rule returned, and never the one
// that arrived. A value outside its rule becomes the default; nothing throws.
// The same of what the cells of a table make together (`closeGrid`), and of a
// node put where the schema cannot hold it, which is left out alone
// (`closeSchema`, `holdBinding`).
//
// Every control is the design package's (E2), and every name the stylesheet
// answers to is the one its contract gives (`@ekdotico/domico`, "The document
// surface"). Nothing of Novel is here: docs/decisions/0005-editor-and-novel.md.
'use client';

import { createContext, useContext, useId, useState } from 'react';
import { Extension, mergeAttributes, Node } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Collaboration from '@tiptap/extension-collaboration';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Fragment, type Node as PMNode, type NodeType, type Schema } from '@tiptap/pm/model';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { Plugin, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type Editor,
  type NodeViewProps,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  updateYFragment,
  ySyncPluginKey,
  yXmlFragmentToProseMirrorRootNode,
  type ProsemirrorBinding,
} from '@tiptap/y-tiptap';
import { common, createLowlight } from 'lowlight';
import * as Y from 'yjs';
import { Button, MenuButton, RadioGroup, Select } from '@ekdotico/domico/components';
import { LightbulbIcon, StickyNoteIcon, TriangleAlertIcon } from '@ekdotico/domico/icons';
import { FRAGMENT_NAME } from '../../../../lib/collab/protocol.ts';
import { shapeOf } from '../../../../lib/collab/shape.ts';
import { linkAddress } from '../../../../lib/editor/link.ts';
import styles from './editor.module.css';
import { MarkdownInput } from './input-rules.ts';
import { Shortcuts } from './shortcuts.ts';
import { SlashPalette } from './slash-palette.tsx';
import { limitRefusal, overLimits } from './block-limits.ts';
import { CODE_NOT_COLOURED, codeColours } from './code-colours.ts';
import {
  TABLE_MOST,
  closeNested,
  firstOf,
  madeOf,
  tableRoom,
  tablesEndingCells,
  tablesIn,
} from './table-bounds.ts';

/** Whether the document can be edited now: the role, and the connection (FR-ED-18). Node views read it. */
export const Editable = createContext(false);

/** The mark on the element that holds a block's controls: Alt+F10 looks for it (./editor.tsx). */
export const BLOCK_CONTROLS = 'data-block-controls';

/**
 * A block's own controls, inside the block and outside its text. Escape
 * returns to the text, unless a control used the key itself (a menu closing
 * its list).
 */
function BlockControls({
  editor,
  className,
  children,
}: {
  editor: Editor;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      {...{ [BLOCK_CONTROLS]: '' }}
      className={className}
      contentEditable={false}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) editor.commands.focus();
      }}
    >
      {children}
    </div>
  );
}

/**
 * Writes text to the clipboard. False where the browser refused it, or offers
 * no clipboard at all, as on a page that is not served securely: either way
 * nothing was copied, and the one who asked is told so (the owner's decision
 * of 9 October 2026). No other way of copying is tried.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// The owner approves the words with the pull request (the answer to Q6 of the plan).
const CODE_NOT_COPIED =
  'The code could not be copied. The browser may have refused access to the clipboard. Select the code and copy it with the keyboard.';

// ── Code block (FR-ED-03) ───────────────────────────────────────────────────

// "The languages in lowlight's common set" (register D46), each under the name
// its own project writes. `plaintext` is first, and is what a new block has.
const LANGUAGES: Record<string, string> = {
  plaintext: 'Plain text',
  arduino: 'Arduino',
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  graphql: 'GraphQL',
  ini: 'INI and TOML',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  kotlin: 'Kotlin',
  less: 'Less',
  lua: 'Lua',
  makefile: 'Makefile',
  markdown: 'Markdown',
  objectivec: 'Objective-C',
  perl: 'Perl',
  php: 'PHP',
  'php-template': 'PHP template',
  python: 'Python',
  'python-repl': 'Python REPL',
  r: 'R',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  shell: 'Shell session',
  sql: 'SQL',
  swift: 'Swift',
  typescript: 'TypeScript',
  vbnet: 'Visual Basic .NET',
  wasm: 'WebAssembly',
  xml: 'HTML and XML',
  yaml: 'YAML',
};

/** The language as one of the list, whatever the attribute holds. */
export const codeLanguage = (given: unknown): string =>
  typeof given === 'string' && Object.hasOwn(LANGUAGES, given) ? given : 'plaintext';

function CodeBlockView({ node, updateAttributes, editor, decorations }: NodeViewProps) {
  const editable = useContext(Editable);
  const id = useId();
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');
  const language = codeLanguage(node.attrs.language);

  async function copy() {
    if (!(await copyText(node.textContent))) return setCopied('refused');
    setCopied('yes');
    // The statement of a refusal stays until the next press; this one goes.
    setTimeout(() => setCopied((now) => (now === 'yes' ? 'no' : now)), 2000);
  }

  return (
    <NodeViewWrapper className="ekd-code">
      <BlockControls editor={editor} className="ekd-code-header">
        <Select
          id={id}
          label="Code language"
          labelHidden
          size="small"
          value={language}
          disabled={!editable}
          onChange={(event) => updateAttributes({ language: event.target.value })}
        >
          {Object.entries(LANGUAGES).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </Select>
        <Button variant="quiet" onClick={copy}>
          {copied === 'yes' ? 'Copied' : 'Copy'}
        </Button>
        {/* A refusal is said where it is seen as well as heard: the button does not say it. */}
        <span role="status" className={copied === 'refused' ? undefined : 'sr-only'}>
          {copied === 'yes' ? 'Code copied' : copied === 'refused' ? CODE_NOT_COPIED : ''}
        </span>
        {/* D183 as D193 reduces it: a block whose grammar threw is shown
            without its colours, and the header says so for as long as it is,
            to every reader of the block, whether or not it can be edited. A
            statement that stands, and no announcement: it is read with the
            header when the block is come to, and says nothing while the code
            is typed. The colours plugin marks such a block (code-colours.ts). */}
        {decorations.some((each) => (each.spec as { codeColoursFailed?: boolean }).codeColoursFailed) ? (
          <span>{CODE_NOT_COLOURED}</span>
        ) : null}
      </BlockControls>
      {/* FR-ED-03: "Code blocks shall not be subject to spell-checking". */}
      <pre spellCheck={false}>
        <NodeViewContent<'code'> as="code" className={`hljs language-${language}`} />
      </pre>
    </NodeViewWrapper>
  );
}

// ── Callout (FR-ED-04) ──────────────────────────────────────────────────────

const CALLOUTS = {
  note: { label: 'Note', Icon: StickyNoteIcon },
  warning: { label: 'Warning', Icon: TriangleAlertIcon },
  tip: { label: 'Tip', Icon: LightbulbIcon },
} as const;
type CalloutType = keyof typeof CALLOUTS;

export const calloutType = (given: unknown): CalloutType =>
  typeof given === 'string' && Object.hasOwn(CALLOUTS, given) ? (given as CalloutType) : 'note';

function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const editable = useContext(Editable);
  const name = useId();
  const type = calloutType(node.attrs.type);
  const { label, Icon } = CALLOUTS[type];
  return (
    <NodeViewWrapper
      as="aside"
      className="callout"
      data-type={type}
      data-icon=""
      role="note"
      aria-label={label}
    >
      <span className="callout-icon" contentEditable={false}>
        <Icon />
      </span>
      <div className="callout-body">
        <NodeViewContent />
        {editable ? (
          <BlockControls editor={editor} className={styles.controls}>
            <RadioGroup
              legend="Callout type"
              name={name}
              value={type}
              onChange={(value) => updateAttributes({ type: calloutType(value) })}
              options={Object.entries(CALLOUTS).map(([value, each]) => ({ value, label: each.label }))}
            />
          </BlockControls>
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}

const Callout = Node.create({
  name: 'callout',
  group: 'block',
  // FR-ED-04: the body takes the marks a paragraph takes.
  content: 'paragraph+',
  defining: true,
  addAttributes() {
    return {
      type: {
        default: 'note',
        parseHTML: (element) => calloutType(element.getAttribute('data-type')),
        renderHTML: (attributes) => ({ 'data-type': calloutType(attributes.type) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'aside.callout' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    const attributes = {
      class: 'callout',
      role: 'note',
      'aria-label': CALLOUTS[calloutType(node.attrs.type)].label,
    };
    return ['aside', mergeAttributes(HTMLAttributes, attributes), ['div', { class: 'callout-body' }, 0]];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});

// ── Table of contents (FR-ED-06) ────────────────────────────────────────────

const TOC_TITLE = 'Table of contents';
const TOC_DEPTHS = [
  { value: '1', label: 'Level 1' },
  { value: '2', label: 'Levels 1–2' },
  { value: '3', label: 'Levels 1–3' },
];

export const tocDepth = (given: unknown): 1 | 2 | 3 =>
  Number(given) === 1 ? 1 : Number(given) === 2 ? 2 : 3;

function TableOfContentsView({ node, updateAttributes, editor }: NodeViewProps) {
  const editable = useContext(Editable);
  const name = useId();
  const depth = tocDepth(node.attrs.depth);
  // FR-ED-06: "from all heading blocks present in the document at the time of
  // rendering", and again at every change, another client's included.
  const headings = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const found: { level: number; text: string; pos: number }[] = [];
      current.state.doc.descendants((each, pos) => {
        if (each.type.name === 'heading') {
          found.push({ level: Number(each.attrs.level), text: each.textContent, pos });
        }
        return !each.isTextblock;
      });
      return found;
    },
  });
  // A heading without text would be a link without a name: it is listed once it has one.
  const entries = headings.filter(({ level, text }) => level <= depth && text.trim() !== '');

  function go(event: React.MouseEvent, pos: number) {
    event.preventDefault();
    if (editor.isEditable)
      editor
        .chain()
        .setTextSelection(pos + 1)
        .focus(undefined, { scrollIntoView: false })
        .run();
    // Without motion of its own: the browser's, which follows the reader's setting.
    (editor.view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView({ block: 'start' });
  }

  return (
    <NodeViewWrapper as="nav" className="ekd-toc" aria-label={TOC_TITLE} contentEditable={false}>
      <p className="ekd-toc-title">{TOC_TITLE}</p>
      {entries.length > 0 ? (
        <ol className="ekd-toc-list">
          {entries.map(({ level, text, pos }, index) => (
            <li key={`${index}-${pos}`} data-level={level}>
              <a href={`#heading-${index + 1}`} onClick={(event) => go(event, pos)}>
                {text}
              </a>
            </li>
          ))}
        </ol>
      ) : (
        <p>
          {editable
            ? 'No headings yet. This list shows each heading of the document. Add a heading to the document to list it here.'
            : 'No headings yet. This list shows each heading of the document.'}
        </p>
      )}
      {editable ? (
        <BlockControls editor={editor} className={styles.controls}>
          <RadioGroup
            legend="Headings listed"
            name={name}
            value={String(depth)}
            onChange={(value) => updateAttributes({ depth: tocDepth(value) })}
            options={TOC_DEPTHS}
          />
        </BlockControls>
      ) : null}
    </NodeViewWrapper>
  );
}

const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      depth: {
        default: 3,
        parseHTML: (element) => tocDepth(element.getAttribute('data-depth')),
        renderHTML: (attributes) => ({ 'data-depth': tocDepth(attributes.depth) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'nav.ekd-toc' }];
  },
  renderHTML({ HTMLAttributes }) {
    const attributes = { class: 'ekd-toc', 'aria-label': TOC_TITLE };
    return ['nav', mergeAttributes(HTMLAttributes, attributes), ['p', { class: 'ekd-toc-title' }, TOC_TITLE]];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TableOfContentsView);
  },
});

// ── Page break (FR-ED-07) ───────────────────────────────────────────────────

const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  parseHTML() {
    return [{ tag: 'div.ekd-page-break' }];
  },
  renderHTML() {
    return ['div', { class: 'ekd-page-break' }, 'Page break'];
  },
});

// ── Table, with its caption (FR-ED-09) ──────────────────────────────────────

// The nine operations, in the order of the requirement. The ninth is named
// by what it does now (Expression Guidelines, functional register).
const TABLE_ACTIONS = [
  ['addRowBefore', 'Add row above'],
  ['addRowAfter', 'Add row below'],
  ['addColumnBefore', 'Add column left'],
  ['addColumnAfter', 'Add column right'],
  ['deleteRow', 'Delete row'],
  ['deleteColumn', 'Delete column'],
  ['mergeCells', 'Merge cells'],
  ['splitCell', 'Split cell'],
  ['toggleHeaderRow', 'Add header row'],
] as const;

function TableBlockView({ node, editor, getPos }: NodeViewProps) {
  const editable = useContext(Editable);
  // What the selection allows, where the table of this block is the innermost
  // table round it. An action of this menu never reaches another table: not
  // the one this table stands in, and not one in a cell of this table, which
  // has a menu of its own (R32). The library's commands act on the innermost
  // table round the selection, so that is the one table whose menu offers
  // them.
  //
  // The caption of a table is in no cell of it. So from the caption of a table
  // that stands in a cell, the innermost table is the one round that cell, and
  // it is that table's menu that answers, for the row and the column of the
  // cell; the menu of the caption's own table offers nothing, as it does from
  // the caption of a table that stands in no cell.
  const allowed = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const pos = getPos();
      const { $from } = current.state.selection;
      let depth = $from.depth;
      while (depth > 0 && $from.node(depth).type.spec.tableRole !== 'table') depth -= 1;
      // The block of a table is the node round it.
      if (pos === undefined || depth < 2 || $from.before(depth - 1) !== pos) return null;
      const table = $from.node(depth);
      const can = current.can();
      const rows = table.childCount;
      const columns = table.firstChild?.childCount ?? 0;
      // R32: the cells left to the outermost table round this one, and how
      // many an action adds at most: a row its columns, a column its rows, a
      // split the squares of the cell but one.
      const room = tableRoom($from).cells;
      const grid = TableMap.get(table);
      const cell = $from.node(Math.min($from.depth, depth + 2)).attrs;
      const adds = (command: string) =>
        command.startsWith('addRow')
          ? grid.width
          : command.startsWith('addColumn')
            ? grid.height
            : command === 'splitCell'
              ? (Number(cell.colspan) || 1) * (Number(cell.rowspan) || 1) - 1
              : 0;
      return TABLE_ACTIONS.map(
        ([command]) =>
          can[command]() &&
          // The bound of the schema: a row or a column past it would be no table at all.
          !(command.startsWith('addRow') && rows >= TABLE_MOST) &&
          !(command.startsWith('addColumn') && columns >= TABLE_MOST) &&
          adds(command) <= room,
      );
    },
  });
  const headerRow = node.firstChild?.firstChild?.firstChild?.type.name === 'tableHeader';
  // NFR-IC-19: a table with a caption is named by it, and so is its menu, so
  // that two tables, and above all a table in a cell of another, are told
  // apart by more than their place. The caption stands in the element that
  // holds the content of the block and is no child of the figure, so the
  // browser does not name the figure by it. Without a caption both are named
  // as before.
  const caption = node.lastChild?.type.name === 'tableCaption' ? node.lastChild.textContent.trim() : '';
  return (
    <NodeViewWrapper as="figure" className={styles.table} aria-label={caption || undefined}>
      {editable ? (
        <BlockControls editor={editor} className={styles.controls}>
          <MenuButton
            label="Table"
            // The name begins with the word on the button (WCAG 2.5.3).
            aria-label={caption ? `Table: ${caption}` : undefined}
            items={TABLE_ACTIONS.map(([command, label], index) => ({
              label: command === 'toggleHeaderRow' && headerRow ? 'Remove header row' : label,
              disabled: !allowed?.[index],
              separatorBefore: index === 4 || index === 6 || index === 8,
              onSelect: () => {
                if (allowed?.[index]) editor.chain().focus()[command]().run();
              },
            }))}
          />
        </BlockControls>
      ) : null}
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

/** The table and its caption, as one block: "an optional caption field rendered below the table". */
const TableBlock = Node.create({
  name: 'tableBlock',
  group: 'block',
  content: 'table tableCaption',
  isolating: true,
  parseHTML() {
    return [{ tag: 'figure.ekd-table' }];
  },
  renderHTML() {
    return ['figure', { class: 'ekd-table' }, 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TableBlockView);
  },
});

/** Build phases, FR-ED-09: "the caption is plain text below the table". So it takes no mark. */
const TableCaption = Node.create({
  name: 'tableCaption',
  content: 'text*',
  marks: '',
  isolating: true,
  parseHTML() {
    return [{ tag: 'figcaption.ekd-table-caption' }];
  },
  renderHTML() {
    return ['figcaption', { class: 'ekd-table-caption' }, 0];
  },
});

// ── What an attribute may hold ──────────────────────────────────────────────

// The bounds are this file's: the Docs give none (reported for the register).
// Those of a table, and of the tables in its cells, are ./table-bounds.ts.
/** The most cells one cell may span, each way. */
const SPAN_MOST = 100;
export { TABLE_MOST };
/** The widest column a cell may ask for, in CSS pixels. */
const WIDTH_MOST = 2000;
/** The highest number an ordered list may start at. */
const START_MOST = 9999;
const LIST_TYPES: readonly unknown[] = ['1', 'a', 'A', 'i', 'I'];
const ALIGNMENTS: readonly unknown[] = ['left', 'center', 'right'];

/** A whole number from `least` to `most`, or `otherwise`. A number written as text is not one. */
const whole = (given: unknown, least: number, most: number, otherwise: number): number =>
  typeof given === 'number' && Number.isInteger(given) && given >= least && given <= most ? given : otherwise;

type Rule = (given: unknown, attributes: Record<string, unknown>) => unknown;

const span: Rule = (given) => whole(given, 1, SPAN_MOST, 1);
const CELL: Record<string, Rule> = {
  colspan: span,
  rowspan: span,
  // Null, or one width for each column the cell spans, 0 for a column without one.
  colwidth: (given, attributes) =>
    Array.isArray(given) &&
    given.length === span(attributes.colspan, attributes) &&
    given.every((width) => whole(width, 0, WIDTH_MOST, -1) === width)
      ? [...given]
      : null,
  align: (given) => (ALIGNMENTS.includes(given) ? given : null),
};

/**
 * Every attribute of the schema, by node or mark, and what it may hold.
 * tests/unit/editor-schema.test.ts fails where the schema has an attribute
 * that is not here, so an upgrade of the library cannot add one unseen.
 */
export const ATTRIBUTE_RULES: Record<string, Record<string, Rule>> = {
  heading: { level: (given) => whole(given, 1, 3, 1) },
  orderedList: {
    start: (given) => whole(given, 1, START_MOST, 1),
    type: (given) => (LIST_TYPES.includes(given) ? given : null),
  },
  codeBlock: { language: codeLanguage },
  callout: { type: calloutType },
  tableOfContents: { depth: tocDepth },
  tableCell: CELL,
  tableHeader: CELL,
  link: { href: linkAddress },
};

const count = (given: unknown): number => (typeof given === 'number' ? given : 1);

/**
 * The widest row of a table, in columns, as the table library counts it
 * (prosemirror-tables, `findWidth`): the columns its own cells span, and those
 * of every cell above that reaches down into it.
 */
function widest(rows: readonly PMNode[]): number {
  let most = 0;
  // The cells that reach into the row at hand: how many rows further, and how wide.
  let reaching: [further: number, columns: number][] = [];
  for (const row of rows) {
    let width = reaching.reduce((sum, [, columns]) => sum + columns, 0);
    const next = reaching.flatMap(([further, columns]) =>
      further > 1 ? [[further - 1, columns] as [number, number]] : [],
    );
    row.forEach((cell) => {
      width += count(cell.attrs.colspan);
      if (count(cell.attrs.rowspan) > 1)
        next.push([count(cell.attrs.rowspan) - 1, count(cell.attrs.colspan)]);
    });
    most = Math.max(most, width);
    reaching = next;
  }
  return most;
}

/** A row with the spans of its cells changed, or the row itself where `change` changes none. */
function respan(row: PMNode, change: (cell: PMNode) => Record<string, number> | null): PMNode {
  let changed = false;
  const cells: PMNode[] = [];
  row.forEach((cell) => {
    const spans = change(cell);
    if (spans) changed = true;
    // Made by the type, so that the widths follow the span (`CELL.colwidth`).
    cells.push(
      spans ? madeOf(cell.type.create({ ...cell.attrs, ...spans }, cell.content, cell.marks), cell) : cell,
    );
  });
  return changed ? madeOf(row.copy(Fragment.from(cells)), row) : row;
}

/**
 * The rows of a table with its GRID inside the bound, and not its cells alone
 * (the second review of pull request 20). A hundred rows of a hundred cells
 * that each span a hundred columns and a hundred rows pass every rule of a
 * cell, and are a grid of ten thousand columns in which every square is
 * claimed ten thousand times: the table library records each claim, and the
 * tab that opens the document stops answering.
 *
 * So, as an attribute outside its rule becomes the default: a cell that
 * reaches below the last row spans one row; and where a row, with the cells
 * that reach down into it, is then still wider than `TABLE_MOST` columns,
 * every cell of the table spans one row and one column. What is left is at
 * most `TABLE_MOST` each way, which is laid out and answers.
 */
export function closeGrid(table: Fragment): Fragment {
  const rows: PMNode[] = [];
  table.forEach((row, _, at) =>
    rows.push(
      respan(row, (cell) => (count(cell.attrs.rowspan) > table.childCount - at ? { rowspan: 1 } : null)),
    ),
  );
  if (widest(rows) <= TABLE_MOST) return Fragment.from(rows);
  return Fragment.from(
    rows.map((row) =>
      respan(row, (cell) =>
        count(cell.attrs.colspan) > 1 || count(cell.attrs.rowspan) > 1 ? { colspan: 1, rowspan: 1 } : null,
      ),
    ),
  );
}

/** The schemas that have left something out of what they were asked to make, since last asked (`holdBinding`). */
const MENDED = new WeakSet<Schema>();

/**
 * Has the schema apply the rules wherever it makes a node or a mark: from a
 * change of another client, from a paste, from a command, from JSON. The
 * library has no place to say this, so the functions through which it makes
 * them are wrapped. The test of this file's rules fails if an upgrade moves one.
 *
 * - The attributes: the one function through which each type computes them
 *   (`NodeType.computeAttrs`, which prosemirror-model 1.25.12 does not
 *   declare, and `MarkType.create`).
 * - The grid of a table, and the tables in its cells: the three functions
 *   that make a node of the type (`closeGrid`; `closeNested` of
 *   ./table-bounds.ts).
 * - What another client sent (`Schema.node`, `Schema.text`, `Schema.mark`,
 *   which are how the collaboration binding makes everything): a node whose
 *   content does not fit is made WITHOUT the children that do not fit, and
 *   with what it must have, and is not refused. The binding deletes from the
 *   shared document whatever the schema refuses to make, so a refusal here
 *   deleted the whole node for everyone, for one thing in it that should not
 *   be there: a member's table, for a paragraph another client put under it
 *   (the second review of pull request 20). A node or a mark of no type, and
 *   text that is not text, are nothing.
 */
export function closeSchema(schema: Schema): Schema {
  const table = schema.nodes.table;
  if (table) {
    for (const make of ['create', 'createChecked', 'createAndFill'] as const) {
      const inner = table[make].bind(table) as NodeType['create'];
      table[make] = ((attrs, content, marks) => {
        const grid = closeGrid(Fragment.from(content));
        // R32: the tables in its cells, inside the bounds they share with it.
        // What that leaves out is taken out of the shared document, as below.
        const rows = closeNested(grid);
        if (rows !== grid) MENDED.add(schema);
        return inner(attrs, rows, marks);
      }) as NodeType['create'];
    }
  }
  const text = schema.text.bind(schema);
  schema.node = ((type, attrs, content, marks) => {
    const made = typeof type === 'string' ? schema.nodes[type] : type;
    const given = Fragment.from(content);
    if (made?.validContent(given)) return made.create(attrs, given, marks);
    MENDED.add(schema);
    if (!made) return null;
    // The children the content of the type takes, in their order; a mark it does not take is left off.
    //
    // IN THEIR ORDER, so that of 101 rows it is the last that goes, and of two
    // tables in a block the second, whoever put which there: a row put at the
    // top of a full table costs the row at the bottom. Leaving out the newest
    // instead was looked at (the third review, 12 October 2026) and cannot be
    // done: a shared document holds no time. A struct has the number of its
    // client and that client's own count, which orders the changes of one
    // client and says nothing between two; and both are chosen by whoever
    // sends the struct, a client of a new number counting from 0, or from any
    // number at all. Every browser would agree on such an order, and a member
    // who wished could make any row "the oldest". The order of the document
    // is the one thing every browser holds alike that says where a thing is.
    const kept: PMNode[] = [];
    let match = made.contentMatch;
    given.forEach((child) => {
      const next = match.matchType(child.type);
      if (!next) return;
      kept.push(child.mark(made.allowedMarks(child.marks)));
      match = next;
    });
    return made.createAndFill(attrs, kept, marks);
  }) as Schema['node'];
  schema.mark = ((type, attrs) => {
    const made = typeof type === 'string' ? schema.marks[type] : type;
    if (made) return made.create(attrs);
    MENDED.add(schema);
    return null;
  }) as Schema['mark'];
  schema.text = ((words, marks) => {
    const known = marks?.filter(Boolean);
    if (typeof words !== 'string' || known?.length !== marks?.length) MENDED.add(schema);
    return typeof words === 'string' ? text(words, known) : null;
  }) as Schema['text'];

  const closed = (name: string, spec: Record<string, { default?: unknown }>, made: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(spec).map((key) => {
        const rule = ATTRIBUTE_RULES[name]?.[key];
        // An attribute without a rule holds its default and nothing else.
        return [key, rule ? rule(made[key], made) : (spec[key]!.default ?? null)];
      }),
    );
  for (const type of Object.values(schema.nodes)) {
    const spec = type.spec.attrs;
    if (!spec || Object.keys(spec).length === 0) continue;
    const inner = type as unknown as { computeAttrs(given: unknown): Record<string, unknown> };
    const compute = inner.computeAttrs.bind(type);
    inner.computeAttrs = (given) => (given ? closed(type.name, spec, compute(given)) : compute(given));
  }
  for (const type of Object.values(schema.marks)) {
    const spec = type.spec.attrs;
    if (!spec || Object.keys(spec).length === 0) continue;
    const create = type.create.bind(type);
    type.create = (given = null) => (given ? create(closed(type.name, spec, create(given).attrs)) : create());
  }
  return schema;
}

/**
 * FR-ED-18: whether a transaction may be applied. One that changes the
 * document is applied only while the document can be edited, whichever control
 * or command made it: a dialog or a menu that was open when the connection was
 * lost changes nothing. A change that arrives from the collaboration binding
 * is another client's, or the undoing of one's own, and always passes.
 */
export function mayApply(transaction: Transaction, editable: boolean): boolean {
  const binding = transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return !transaction.docChanged || editable || binding?.isChangeOrigin === true;
}

// The origin of a mending of the shared document. Not one the undo manager
// tracks: what is mended is no one's change to undo.
const MEND = 'mend';

/**
 * Where, among what stands directly in the shared document, there is something
 * the document cannot hold: text, a node of no type, a row or a cell without
 * its table. Chosen as `closeSchema` chooses among the children of a node: in
 * their order, each that the content does not take after those before it.
 */
function strays(shared: Y.XmlFragment, schema: Schema): number[] {
  const found: number[] = [];
  let match = schema.topNodeType.contentMatch;
  shared.toArray().forEach((child, at) => {
    // Text and a hook have no name.
    const name = (child as { nodeName?: unknown }).nodeName;
    const next = typeof name === 'string' && schema.nodes[name] ? match.matchType(schema.nodes[name]) : null;
    if (next) match = next;
    else found.push(at);
  });
  return found;
}

/**
 * An element of the shared document, told from text by what it carries and
 * not by its class: were a second copy of Yjs ever loaded, `instanceof` would
 * take every element for text, and `leftOut` would then take out every child
 * of a parent that holds no text.
 */
const isElement = (child: unknown): child is Y.XmlElement =>
  typeof (child as { nodeName?: unknown }).nodeName === 'string';

/**
 * What stands in the shared document and not in the text the binding has just
 * built of it: the children the schema left out (`closeSchema`), each with the
 * element it stands in and its place there, in the order of the document.
 *
 * WHY THEY ARE FOUND HERE, AND NOT BY THE LIBRARY'S COMPARISON (the owner's
 * decision of 13 October 2026; measured for the re-review of pull request 35).
 * The comparison lines the children of an element up from both ends, and what
 * is between the first and the last that differ it deletes and puts in again.
 * So where children that go stood between children that stay, those that stay
 * were written again by every browser that mended: of ten paragraphs of a
 * quotation with a row between each two, mended by two browsers at once, four
 * were there twice and four were gone, and what a third writer was typing in
 * one of them was lost. Taken out one by one, each as the element it is, two
 * browsers delete the same and nothing that stays is touched; and what is
 * left lines up one to one for the comparison, which then has only to add.
 *
 * An element STAYS where the node the binding made of it (`mapping`) is in the
 * node made of the element it stands in; or a node that a rule made again of
 * that one is (`firstOf` of ./table-bounds.ts: a row whose cells span less, a
 * cell out of which a table was left). What is in an element that goes is not
 * looked at. Text stays wherever the node holds text: what is wrong in it is
 * the comparison's to write, in place.
 */
function leftOut(
  shared: Y.XmlFragment,
  mapping: Map<unknown, unknown>,
): [parent: Y.XmlFragment, at: number][] {
  const going: [Y.XmlFragment, number][] = [];
  const visit = (parent: Y.XmlElement, node: PMNode): void => {
    const stay = new Map<unknown, PMNode>();
    node.forEach((child) => stay.set(firstOf(child), child));
    parent.toArray().forEach((child, at) => {
      if (!isElement(child)) {
        if (!node.inlineContent) going.push([parent, at]);
      } else if (stay.has(mapping.get(child))) visit(child, stay.get(mapping.get(child))!);
      else going.push([parent, at]);
    });
  };
  // What stands directly in the document is asked of no node; and what cannot
  // stand there is gone before the text is built (`strays`).
  for (const child of shared.toArray()) {
    const made = mapping.get(child);
    if (isElement(child) && made) visit(child, made as PMNode);
  }
  return going;
}

/** Deletes children from the shared document they stand in. They are given in the order of the document. */
function takeOut(blocks: readonly (readonly [parent: Y.XmlFragment, at: number, ...unknown[]])[]): void {
  blocks[0]?.[0].doc!.transact(() => {
    // From the last, so that no place moves before it is used; and those
    // that stand side by side in one deletion, since each deletion counts
    // its way to its place.
    let end = blocks.length;
    for (let at = blocks.length - 1; at >= 0; at -= 1) {
      const [parent, place] = blocks[at]!;
      const before = blocks[at - 1];
      if (before && before[0] === parent && before[1] === place - 1) continue;
      parent.delete(place, end - at);
      end = at;
    }
  }, MEND);
}

/**
 * Holds the collaboration binding to two things, at the three functions
 * through which the shared document and the text of the editor meet
 * (`ProsemirrorBinding` of @tiptap/y-tiptap 3.0.9: `_forceRerender` at the
 * start, `_observeFunction` at each change of the shared document,
 * `_prosemirrorChanged` at each change of the text).
 *
 * A DOCUMENT THAT CANNOT BE BUILT DOES NOT TAKE THE PAGE DOWN. The binding
 * builds the whole text from the shared document by recursion, and the editor
 * lays it out, so a document can be one that a browser cannot build: quotes
 * nested ten thousand deep are enough (the second review of pull request 20).
 * The fault is caught here, `unshown` is told once, and from then on the
 * binding does nothing: above all it writes nothing back, since the text it
 * holds is no longer the document's.
 *
 * WHAT THE SCHEMA LEFT OUT IS TAKEN OUT OF THE SHARED DOCUMENT, and nothing
 * else is (`closeSchema`; `strays` for what stands directly in the document,
 * which the schema is not asked about). The binding counts places in the text by the shared
 * document, so the two must hold the same. What was not made is deleted, each
 * as the element it is (`leftOut`), and then the library's own comparison
 * writes what the making added: the paragraph of a cell left with nothing, an
 * attribute that had no value. One change, which is not this member's, and is
 * in no history of undo.
 *
 * ONLY A BROWSER THAT CAN EDIT THE DOCUMENT WRITES TO IT (the review of pull
 * request 34). A mending is a change to the shared document, and one made
 * where the document cannot be edited is sent to a server that takes nothing
 * from that connection: it reaches no one, and the page says "Syncing" for
 * good. So where the text cannot be edited nothing is mended. The text is
 * still made without what the schema leaves out, which no one types into
 * there. And what was not mended is mended when the text can be edited again,
 * the connection having come back or the read-only state ended: the function
 * this returns is called at each change of the view, and then makes the text
 * again from the shared document and mends it, once, before this member types
 * anything into it.
 *
 * NO MENDING THAT WOULD PASS 5 MB IS WRITTEN (register D180, the browser's
 * half): `unrepairable` is told, once, and the tab is read-only, with nothing
 * written, rather than sending what the server would refuse. Nor one the
 * server would refuse for the shape of the document (`shapeOf`): where the
 * filled text is past a limit of the document, it opens to deletions alone
 * instead, and the mending is written once deletions bring it back under.
 *
 * A READER'S BROWSER DOES NOT COME HERE (`followShared`; register D185, D190).
 * A browser that holds no role that edits is built without this binding,
 * which writes to the shared document in more places than the mending: it
 * makes the text of a copy of the document, and shows that.
 */
// `MAX_STATE_BYTES` of src/lib/collab/state.ts, a module of the server:
// tests/unit/editor-schema.test.ts holds the two together.
export const DOCUMENT_BYTES_MOST = 5 * 1024 * 1024;
export function holdBinding(
  view: EditorView,
  unshown: () => void,
  unrepairable: () => void = () => {},
): () => void {
  const { binding } = ySyncPluginKey.getState(view.state) as { binding: ProsemirrorBinding };
  const { schema } = view.state;
  // What stands in for a view in the tests has no such property, and can edit.
  const writes = () => (view as { editable?: boolean }).editable !== false;
  /** Takes what stands directly in the shared document where it cannot. True where there was any. */
  const unstray = () => {
    const stray = strays(binding.type, schema);
    if (stray.length > 0 && writes()) {
      binding.doc.transact(() => {
        for (const at of stray.reverse()) binding.type.delete(at, 1);
      }, MEND);
    }
    return stray.length > 0;
  };
  /**
   * Takes out of the shared document what the building left out, and then
   * puts in what it added: on `doc`, the shared document or a copy of it whose
   * elements are found by the items they are.
   */
  const repair = (doc: Y.Doc, going: readonly [parent: Y.XmlFragment, at: number][]) => {
    const type = doc === binding.doc ? binding.type : doc.getXmlFragment(FRAGMENT_NAME);
    const same = (parent: Y.XmlFragment) =>
      doc === binding.doc
        ? parent
        : parent._item
          ? (((Y.getItem(doc.store, parent._item.id) as Y.Item).content as Y.ContentType)
              .type as Y.XmlFragment)
          : type;
    // A mapping of its own: the binding's says each node is the one it made,
    // which is what the comparison must not take on trust here.
    const fresh = { mapping: new Map(), isOMark: new Map() };
    doc.transact(() => {
      takeOut(going.map(([parent, at]) => [same(parent), at] as const));
      updateYFragment(doc, type, view.state.doc, fresh);
    }, MEND);
  };
  /**
   * One change, and only where it leaves the document inside 5 MB (D180): a
   * repair can be far larger than what made it needed (D170), and a server
   * that refused it would hold this tab, which changed nothing. It is made on
   * a copy first and measured as the server measures a document: where it
   * would pass, nothing is written, and the tab is read-only (`unrepairable`).
   */
  //
  // NOR ONE THAT THE SERVER WOULD REFUSE FOR THE SHAPE OF A DOCUMENT (the
  // review of pull request 42). Emptying an element is never refused (D180),
  // so a client can empty a quote or a table's block in a document at a limit;
  // the filling that every browser then writes would pass the limit, be
  // refused, and hold every tab on opening, with no one left to delete. The
  // copy is asked as the server asks (`shapeOf`). Where it would be refused,
  // nothing is written and the tab is not held: the text, filled, is past the
  // limit, so it opens to deletions alone with the statement of the limit
  // (`overLimits`, `limitRefusal` of ./block-limits.ts). Each change of the
  // writer's is then written as a mending of the whole text, asked again
  // (`shaped`): nothing until the deletions bring it back under, and then the
  // deletions and the filling together. Where the text is past no limit, the
  // refusal is of a rule this browser cannot answer, and the tab is read-only
  // as for 5 MB.
  const mend = () => {
    const going = leftOut(binding.type, binding.mapping);
    const copy = new Y.Doc();
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(binding.doc));
      repair(copy, going);
      const fits = Y.encodeStateAsUpdate(copy).byteLength <= DOCUMENT_BYTES_MOST;
      const refused =
        fits && shapeOf(binding.doc, Y.encodeStateAsUpdate(copy, Y.encodeStateVector(binding.doc))) !== null;
      shaped = refused && overLimits(view.state.doc).length > 0;
      if (shaped) return;
      if (!fits || refused) {
        unrepaired = true;
        unrepairable();
        return;
      }
    } finally {
      copy.destroy();
    }
    repair(binding.doc, going);
  };
  // Whether the last mending was not written because the server would refuse it, the text being past a limit.
  let shaped = false;
  let failed = false;
  // Whether a mending was left unwritten because the text could not be edited.
  let owed = false;
  // Whether a mending was not written because it would take the document past
  // 5 MB (D180). Held for as long as the tab is open: the tab is read-only,
  // and reloading it tries again.
  let unrepaired = false;
  const held =
    <Given extends unknown[]>(run: (...given: Given) => void, builds: boolean) =>
    (...given: Given) => {
      if (failed) return;
      try {
        if (builds) {
          // Before the text is built, and not after as below: the library
          // makes the document itself without asking the schema, so what
          // stands directly in it where it cannot is not left out. A row is
          // put into a table that the shared document does not hold, and the
          // next thing this member types writes that table over the row, as
          // this member's change; and text is a fault of the building, which
          // closed the document in every tab.
          if (unstray() && !writes()) owed = true;
          // What the making above left out is not what the building leaves out.
          MENDED.delete(schema);
        }
        run(...given);
        if (builds && MENDED.delete(schema)) {
          if (writes() && !unrepaired) mend();
          else owed = true;
        }
      } catch {
        failed = true;
        unshown();
      }
    };
  binding._forceRerender = held(binding._forceRerender.bind(binding), true);
  binding._observeFunction = held(binding._observeFunction as (...given: unknown[]) => void, true);
  const changed = held(binding._prosemirrorChanged.bind(binding), false);
  // Where the repair was not written, nothing of the text is: it holds what
  // the shared document does not. Where the server would have refused it,
  // the text, deletions alone, is written with it once the server would not.
  const remend = held(mend, false);
  binding._prosemirrorChanged = (...given) =>
    unrepaired ? undefined : shaped ? remend() : changed(...given);
  return () => {
    if (!owed || !writes() || failed || unrepaired) return;
    owed = false;
    // The whole text again, from the shared document: what was left out of
    // it is left out again, and this time it is mended. Once the change of
    // the view that this is called in is done, and not inside it.
    setTimeout(() => binding._forceRerender(), 0);
  };
}

/**
 * The text of what the schema can show of a shared document, for a browser
 * that cannot edit it (register D185, D190; docs/plan/reader-view.md). It is
 * made of a COPY of the document: the library deletes from the document it is
 * given whatever fails to build, and a reader's browser writes nothing to the
 * shared one. What stands directly in the copy where it cannot (`strays`) is
 * taken out of the copy first, as an editor's browser takes it out of the
 * shared document, and then the text is made by the library's own function
 * over the closed schema (`closeSchema`). So a reader is shown what an editor
 * will show once it has mended. A document left with nothing is the schema's
 * empty one. A fault of the making (quotes nested ten thousand deep) is thrown.
 */
export function shownOf(shared: Y.Doc, schema: Schema): PMNode {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(shared));
    const fragment = copy.getXmlFragment(FRAGMENT_NAME);
    for (const at of strays(fragment, schema).reverse()) fragment.delete(at, 1);
    const made = yXmlFragmentToProseMirrorRootNode(fragment, schema);
    const whole = made.type.createAndFill(null, made.content);
    if (!whole) throw new Error('editor: the document cannot be made whole');
    return whole;
  } finally {
    copy.destroy();
  }
}

/**
 * Shows `shownOf` the shared document in `view`, now and after each change of
 * the document, whoever made it: the way a reader's browser follows an editor,
 * and follows the repair when one is written. Nothing is written to the shared
 * document, which is only read. Changes of one moment are shown once. Returns
 * the function that stops it.
 *
 * The change to the view is the smallest that makes the text equal, so that a
 * selection in a part that did not change stays where it is. It carries the
 * meta of the binding, which the filters of `Closed` read as what arrives and
 * not as the writer's own change, and it is in no history. A text that cannot
 * be made is told to `unshown`, once, and nothing more is shown.
 */
export function followShared(view: EditorView, document: Y.Doc, unshown: () => void): () => void {
  let over = false;
  let queued = false;
  const arrives = (tr: Transaction) =>
    tr.setMeta('addToHistory', false).setMeta(ySyncPluginKey, { isChangeOrigin: true });
  const show = () => {
    queued = false;
    if (over) return;
    let next: PMNode;
    try {
      next = shownOf(document, view.state.schema);
    } catch {
      over = true;
      unshown();
      return;
    }
    const start = view.state.doc.content.findDiffStart(next.content);
    if (start === null) return;
    try {
      let { a, b } = view.state.doc.content.findDiffEnd(next.content)!;
      const overlap = start - Math.min(a, b);
      if (overlap > 0) {
        a += overlap;
        b += overlap;
      }
      view.dispatch(arrives(view.state.tr.replace(start, a, next.slice(start, b))));
    } catch {
      // Not made by the smallest change: the whole text is, below.
    }
    if (!view.state.doc.eq(next)) {
      view.dispatch(arrives(view.state.tr.replaceWith(0, view.state.doc.content.size, next.content)));
    }
  };
  const changed = () => {
    if (queued || over) return;
    queued = true;
    queueMicrotask(show);
  };
  document.on('update', changed);
  show();
  return () => {
    over = true;
    document.off('update', changed);
  };
}

/** The editor of a reader: the text follows the shared document and is never written to it (`followShared`). */
const ReaderView = Extension.create<
  { document: Y.Doc; unshown: () => void },
  { stop: (() => void) | undefined }
>({
  name: 'readerView',
  addOptions() {
    return { document: new Y.Doc(), unshown: () => {} };
  },
  addStorage() {
    return { stop: undefined };
  },
  onCreate() {
    this.storage.stop = followShared(this.editor.view, this.options.document, this.options.unshown);
  },
  onDestroy() {
    this.storage.stop?.();
  },
});

/**
 * Tab and Shift+Tab into a cell that holds a table (R32). The library selects
 * all that the cell it moves to holds, so that the next letter replaces it,
 * as in a sheet. Where that is a table, the selection ran from its first cell
 * to its caption and the text after it, and one letter left a table of one
 * cell (the review of pull request 28). There the selection becomes a cursor,
 * and nothing is selected for a letter to replace.
 *
 * The cursor goes to the start of the first text that is the cell's own, and
 * not to the first text in the cell, which is in the table it holds: Tab then
 * moves on through the table the writer is moving through, and is not taken
 * into the inner one, where Tab in the last cell adds a row. A cell that
 * holds a table and no text of its own has no such place, and there the
 * cursor goes to the first text in the cell.
 */
function settleInCell(editor: Editor): void {
  const { selection, tr } = editor.state;
  if (selection.empty || !(selection instanceof TextSelection)) return;
  const { $from } = selection;
  const cell = (node: PMNode) => /^(header_)?cell$/.test(String(node.type.spec.tableRole));
  let depth = $from.sharedDepth(selection.to);
  while (depth > 0 && !cell($from.node(depth))) depth -= 1;
  if (depth === 0 || tablesIn($from.node(depth)).levels === 0) return;
  const start = $from.start(depth);
  let own = -1;
  $from.node(depth).forEach((child, offset) => {
    if (own < 0 && child.isTextblock) own = start + offset + 1;
  });
  editor.view.dispatch(
    tr
      .setSelection(own < 0 ? Selection.near(tr.doc.resolve(start), 1) : TextSelection.create(tr.doc, own))
      .scrollIntoView(),
  );
}

/**
 * An arrow key out of a table that begins or ends a cell (R32; the re-review
 * of pull request 28, WCAG 2.1.1). True where the key was taken.
 *
 * A cell that holds a table and nothing after it has no text of its own to
 * put the cursor in, and the arrow keys step from a table to the nearest
 * text, which is in the next cell: so no key reached the place beside the
 * table, and nothing could be written there. Such a cell is made by another
 * client or a stored document; a table from the palette or a paste is
 * followed by a paragraph. Nothing is added for it, since every browser would
 * add its own. The key puts the library's own cursor between blocks there
 * instead, which is a selection and no content: the first letter typed at it
 * makes the paragraph, as this writer's change.
 *
 * Approved by the owner on 13 October 2026 (new behaviour of four keys; reported with the pull
 * request). As at the top of a document, where the arrow up from a table that
 * begins it gives the same cursor before the table:
 *
 * - Down in the caption of a table in a cell, and Right at the end of that
 *   caption, where no text follows the table in the cell: the cursor after
 *   the table, in the cell.
 * - Up in the first line of a cell of the first row of a table in a cell, and
 *   Left at the start of its first cell, where no text is before the table in
 *   the cell: the cursor before the table, in the cell.
 *
 * "No text" is the library's own rule for where its cursor may stand
 * (`GapCursor.valid`): at the edge of the cell, or against another table, and
 * never against a paragraph, where the keys stay the table library's and go
 * to that paragraph. Asked before the table library's own arrows, which would
 * take the key.
 */
function besideTable(editor: Editor, direction: 'up' | 'down' | 'left' | 'right'): boolean {
  const { selection, tr } = editor.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $head } = selection;
  const role = (node: PMNode | null | undefined) => String(node?.type.spec.tableRole);
  const forward = direction === 'down' || direction === 'right';
  // The innermost block of a table round the cursor that stands in a cell.
  let depth = $head.depth - 1;
  while (
    depth > 1 &&
    !(role($head.node(depth).firstChild) === 'table' && /cell$/.test(role($head.node(depth - 1))))
  )
    depth -= 1;
  if (depth <= 1) return false;
  if (forward) {
    // In the caption, which is the last line of the block.
    if ($head.depth !== depth + 1 || role($head.parent) === 'table') return false;
  } else {
    // In the first row of the table, at the first text of a cell; for Left, of the first cell.
    for (let inner = depth; inner < $head.depth; inner += 1) {
      const row = inner === depth + 2;
      if ($head.index(inner) > 0 && !(row && direction === 'up')) return false;
    }
    if (role($head.node(depth + 1)) !== 'table') return false;
  }
  if (!editor.view.endOfTextblock(direction)) return false;
  const $beside = tr.doc.resolve(forward ? $head.after(depth) : $head.before(depth));
  if (!(GapCursor as unknown as { valid($pos: typeof $beside): boolean }).valid($beside)) return false;
  editor.view.dispatch(tr.setSelection(new GapCursor($beside)).scrollIntoView());
  return true;
}

const Closed = Extension.create<{ noRoom: (words: string | null) => void }>({
  name: 'closed',
  addOptions() {
    return { noRoom: () => {} };
  },
  onBeforeCreate() {
    closeSchema(this.editor.schema);
  },
  addProseMirrorPlugins() {
    // Whether the words of a refusal stand. `noRoom` is given the words at
    // each refusal, so that a second one is heard as the first was, and null
    // when the document next changes, whoever changes it: the refusal was of
    // one change to the document as it then was (the re-review of pull request
    // 28: the words outlived their cause, through another client's change and
    // the writer's own undo, which arrives as the binding's).
    let said = false;
    return [
      new Plugin({
        filterTransaction: (transaction, state) => {
          if (!mayApply(transaction, this.editor.isEditable)) return false;
          const refusal = limitRefusal(transaction, state.doc);
          const held = refusal === null;
          // NFR-IC-19 (WCAG 3.3.1, 4.1.3): a change that is not made is said
          // to be so. Of this writer's own asking only: not what the binding
          // brings, and not what a plugin appends, which is the table
          // library's repair, tried again at every key and asked for by no one.
          const asked =
            transaction.docChanged &&
            !transaction.getMeta(ySyncPluginKey) &&
            transaction.getMeta('appendedTransaction') === undefined;
          if (!held && asked) {
            said = true;
            this.options.noRoom(refusal);
          } else if (held && transaction.docChanged && said) {
            said = false;
            this.options.noRoom(null);
          }
          return held;
        },
        // R32: a table that a paste or a drop of this writer's leaves at the
        // end of a cell is followed by an empty paragraph, as one from the
        // palette is (./slash-palette.tsx), and in the same step of undo. So
        // is a table that already ended its cell, where the paste changed
        // anything inside that table (`tablesEndingCells` says why). Never
        // for a cell as another client or a stored document made it, in whose
        // table this writer pasted nothing: that would be an addition every
        // browser writes for itself.
        appendTransaction: (transactions, before, state) => {
          const pasted = transactions.some(
            (each) => each.docChanged && (each.getMeta('paste') || each.getMeta('uiEvent') === 'drop'),
          );
          const ends = pasted ? tablesEndingCells(before.doc, state.doc) : [];
          if (ends.length === 0) return null;
          const { tr } = state;
          // From the last, so that no place moves before it is used.
          for (const at of ends.reverse()) tr.insert(at, state.schema.nodes.paragraph!.create());
          return tr;
        },
      }),
    ];
  },
});

/**
 * What tells a writer of the slash palette (FR-ED-10): the owner's sentence
 * of 12 October 2026, word for word, in the description of the text
 * (./editor.tsx). A screen reader reads the description after the role of the
 * region, so it begins with the instruction itself; the prompt below is
 * another sentence (R31).
 */
export const SLASH_HINT = 'Type / for a list of blocks.';

/**
 * The prompt of an empty document, for a sighted writer: the owner's decision
 * R31 of 12 October 2026, word for word.
 */
const EMPTY_PROMPT = 'Write here, or type / for a list of blocks.';

/**
 * The prompt of an empty document: one whose only block is an empty
 * paragraph, while it can be edited. It is drawn by the design package's rule
 * for `data-placeholder` and by nothing of the application's.
 *
 * It is a decoration, so it is no content: not in the document, not sent to
 * another client, not copied. It is an element of its own, hidden from a
 * screen reader, and not the attribute on the paragraph: the description of
 * the text gives the instruction already, and a screen reader would read it
 * twice, the second time as the first line of the document (NFR-IC-19).
 * From 0.29.0 the package's rule gives the text it generates an empty
 * alternative text, which takes it out of what is read, but only where the
 * browser parses one (`content: … / ""`). Elsewhere generated text cannot be
 * hidden, so the element and its `aria-hidden` stay.
 */
const EmptyPrompt = Extension.create({
  name: 'emptyPrompt',
  addProseMirrorPlugins() {
    const { editor } = this;
    const prompt = (view: EditorView) => {
      const element = view.dom.ownerDocument.createElement('span');
      element.setAttribute('aria-hidden', 'true');
      element.setAttribute('data-placeholder', EMPTY_PROMPT);
      return element;
    };
    return [
      new Plugin({
        props: {
          decorations({ doc }) {
            const only = doc.firstChild;
            const empty = doc.childCount === 1 && only?.type.name === 'paragraph' && !only.content.size;
            return empty && editor.isEditable
              ? DecorationSet.create(doc, [Decoration.widget(1, prompt, { key: 'empty-prompt' })])
              : null;
          },
        },
      }),
    ];
  },
});

// ── The whole schema ────────────────────────────────────────────────────────

// The code block extension asks for a lowlight instance; its plugin, the one
// that would use it, is left out below.
const lowlight = createLowlight(common);

/**
 * The extensions of the editor, bound to the document of one connection.
 * `unshown` is told, once, that the document cannot be built here (`holdBinding`).
 * `noRoom` is given the words each time a change of the writer's is refused for the bounds of a
 * table or a limit of the document, and null when the next one is not (`Closed`).
 * `unrepairable` is told, once, that a mending was not written because it would pass 5 MB.
 * `reads` is true for a browser that cannot edit the document: it has no binding to the shared
 * document, and shows what the schema can show of it, writing nothing (`followShared`).
 */
export function extensions(
  document: Y.Doc,
  unshown: () => void = () => {},
  noRoom: (words: string | null) => void = () => {},
  unrepairable: () => void = () => {},
  reads = false,
) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // The lowlight block below replaces it.
      codeBlock: false,
      // FR-ED-16: undo and redo are the collaboration extension's, over Yjs.
      undoRedo: false,
      // Replaced by the link below.
      link: false,
    }),
    Link.extend({
      // The address and nothing else. The library's mark also stores `target`,
      // `rel`, `class` and `title`, each of which another client could set to
      // anything; here they are the same for every link, from the options.
      addAttributes() {
        return { href: { default: null, parseHTML: (element) => element.getAttribute('href') } };
      },
    }).configure({
      // FR-ED-02 asks for the mark. Turning typed or pasted text into a link,
      // and following one from the text being edited, are asked for nowhere.
      autolink: false,
      linkOnPaste: false,
      openOnClick: false,
      // Where a link is read from HTML and where it is rendered: an address
      // that is not allowed is no link in the first, and an empty `href` in
      // the second, which is how one that arrived over Yjs is drawn.
      isAllowedUri: (address) => linkAddress(address) !== null,
      // A document reaches other people: a page it links to is told nothing
      // of this one, and is given no handle on its window.
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
    Highlight,
    Subscript,
    Superscript,
    CodeBlockLowlight.extend({
      addNodeView() {
        return ReactNodeViewRenderer(CodeBlockView);
      },
      // The library's plugin colours every block in full at each change; the
      // colours near the view replace it (D193, code-colours.ts). Its other
      // plugins stay.
      addProseMirrorPlugins() {
        const others = (this.parent?.() ?? []).filter(
          (plugin) => !(plugin as unknown as { key: string }).key.startsWith('lowlight$'),
        );
        return [...others, codeColours(codeLanguage)];
      },
    }).configure({ lowlight, defaultLanguage: 'plaintext' }),
    Callout,
    TableOfContents,
    PageBreak,
    // A table stands only inside its block, with its caption. Bounded, so
    // that no table a client sends is too large to lay out (`TABLE_MOST`): a
    // row or a cell past the bound is not content of this schema, and is left
    // out as a node without a type is (`closeSchema`).
    Table.extend({
      group: '',
      content: `tableRow{1,${TABLE_MOST}}`,
      // The library's keys, and after its Tab and Shift+Tab, `settleInCell`.
      addKeyboardShortcuts() {
        const keys = this.parent?.() ?? {};
        const settled =
          (key: 'Tab' | 'Shift-Tab'): NonNullable<(typeof keys)[string]> =>
          (props) => {
            const taken = keys[key]?.(props) ?? false;
            if (taken) settleInCell(this.editor);
            return taken;
          };
        return {
          ...keys,
          Tab: settled('Tab'),
          'Shift-Tab': settled('Shift-Tab'),
          // Out of a table that begins or ends a cell (`besideTable`).
          ArrowDown: () => besideTable(this.editor, 'down'),
          ArrowRight: () => besideTable(this.editor, 'right'),
          ArrowUp: () => besideTable(this.editor, 'up'),
          ArrowLeft: () => besideTable(this.editor, 'left'),
        };
      },
    }),
    TableRow.extend({ content: `(tableCell | tableHeader){0,${TABLE_MOST}}` }),
    TableHeader,
    TableCell,
    TableBlock,
    TableCaption,
    Placeholder.configure({
      showOnlyCurrent: false,
      placeholder: ({ node }) => (node.type.name === 'tableCaption' ? 'Caption' : ''),
    }),
    EmptyPrompt,
    // A browser that cannot edit is built without the binding (`followShared`).
    reads
      ? ReaderView.configure({ document, unshown })
      : Collaboration.extend({
          addProseMirrorPlugins() {
            const plugins = this.parent?.() ?? [];
            // The binding is held before its plugin starts it, as the library
            // itself reaches the plugin of undo: by the function that starts it.
            const sync = plugins.find((plugin) => plugin.spec.key === ySyncPluginKey);
            const start = sync?.spec.view;
            if (!sync || !start) throw new Error('editor: the collaboration binding was not found');
            sync.spec.view = (view) => {
              const settle = holdBinding(view, unshown, unrepairable);
              const made = start(view);
              // At each change of the view, the one that makes the text editable
              // among them: what was owed to the shared document is mended then.
              return {
                ...made,
                update: (...given) => {
                  made.update?.(...given);
                  settle();
                },
              };
            };
            return plugins;
          },
        }).configure({ document, field: FRAGMENT_NAME }),
    Closed.configure({ noRoom }),
    Shortcuts,
    MarkdownInput,
    SlashPalette,
  ];
}
