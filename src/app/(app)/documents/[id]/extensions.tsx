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
import { Plugin, type Transaction } from '@tiptap/pm/state';
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
import { updateYFragment, ySyncPluginKey, type ProsemirrorBinding } from '@tiptap/y-tiptap';
import { common, createLowlight } from 'lowlight';
import type * as Y from 'yjs';
import { Button, MenuButton, RadioGroup, Select } from '@ekdotico/domico/components';
import { LightbulbIcon, StickyNoteIcon, TriangleAlertIcon } from '@ekdotico/domico/icons';
import { FRAGMENT_NAME } from '../../../../lib/collab/protocol.ts';
import { linkAddress } from '../../../../lib/editor/link.ts';
import styles from './editor.module.css';
import { MarkdownInput } from './input-rules.ts';
import { Shortcuts } from './shortcuts.ts';
import { SlashPalette } from './slash-palette.tsx';

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

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
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
  // What the selection allows, where it is inside this table. An action of
  // this menu never reaches another table.
  const allowed = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const pos = getPos();
      const { from } = current.state.selection;
      if (pos === undefined || from <= pos || from >= pos + node.nodeSize) return null;
      const can = current.can();
      const table = current.state.doc.nodeAt(pos);
      const rows = table?.firstChild?.childCount ?? 0;
      const columns = table?.firstChild?.firstChild?.childCount ?? 0;
      return TABLE_ACTIONS.map(
        ([command]) =>
          can[command]() &&
          // The bound of the schema: a row or a column past it would be no table at all.
          !(command.startsWith('addRow') && rows >= TABLE_MOST) &&
          !(command.startsWith('addColumn') && columns >= TABLE_MOST),
      );
    },
  });
  const headerRow = node.firstChild?.firstChild?.firstChild?.type.name === 'tableHeader';
  return (
    <NodeViewWrapper as="figure" className={styles.table}>
      {editable ? (
        <BlockControls editor={editor} className={styles.controls}>
          <MenuButton
            label="Table"
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
/** The most cells one cell may span, each way. */
const SPAN_MOST = 100;
/** The most rows of a table, and the most cells of a row: ten thousand cells at most. */
export const TABLE_MOST = 100;
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
    cells.push(spans ? cell.type.create({ ...cell.attrs, ...spans }, cell.content, cell.marks) : cell);
  });
  return changed ? row.copy(Fragment.from(cells)) : row;
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
 * - The grid of a table: the three functions that make a node of the type
 *   (`closeGrid`).
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
      table[make] = ((attrs, content, marks) =>
        inner(attrs, closeGrid(Fragment.from(content)), marks)) as NodeType['create'];
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
 * document, so the two must hold the same; the text is written back by the
 * library's own comparison, which removes the children that were not made and
 * leaves the node they were in. It is not this member's change, and is in no
 * history of undo.
 */
export function holdBinding(view: EditorView, unshown: () => void): void {
  const { binding } = ySyncPluginKey.getState(view.state) as { binding: ProsemirrorBinding };
  const { schema } = view.state;
  let failed = false;
  const held =
    <Given extends unknown[]>(run: (...given: Given) => void, builds: boolean) =>
    (...given: Given) => {
      if (failed) return;
      try {
        if (builds) {
          MENDED.delete(schema);
          // Before the text is built, and not after as below: the library
          // makes the document itself without asking the schema, so what
          // stands directly in it where it cannot is not left out. A row is
          // put into a table that the shared document does not hold, and the
          // next thing this member types writes that table over the row, as
          // this member's change; and text is a fault of the building, which
          // closed the document in every tab.
          const stray = strays(binding.type, schema);
          if (stray.length > 0) {
            binding.doc.transact(() => {
              for (const at of stray.reverse()) binding.type.delete(at, 1);
            }, MEND);
          }
        }
        run(...given);
        if (builds && MENDED.delete(schema)) {
          // A mapping of its own: the binding's says each node is the one it
          // made, which is what the comparison must not take on trust here.
          const fresh = { mapping: new Map(), isOMark: new Map() };
          binding.doc.transact(() => updateYFragment(binding.doc, binding.type, view.state.doc, fresh), MEND);
        }
      } catch {
        failed = true;
        unshown();
      }
    };
  binding._forceRerender = held(binding._forceRerender.bind(binding), true);
  binding._observeFunction = held(binding._observeFunction as (...given: unknown[]) => void, true);
  binding._prosemirrorChanged = held(binding._prosemirrorChanged.bind(binding), false);
}

const Closed = Extension.create({
  name: 'closed',
  onBeforeCreate() {
    closeSchema(this.editor.schema);
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (transaction) => mayApply(transaction, this.editor.isEditable),
      }),
    ];
  },
});

/**
 * What tells a writer of the slash palette (FR-ED-10): the owner's sentence
 * of 12 October 2026, word for word. It is said in two places: in the
 * description of the text (./editor.tsx), and as the prompt of an empty
 * document, below.
 */
export const SLASH_HINT = 'Type / for a list of blocks.';

/**
 * The prompt of an empty document: one whose only block is an empty
 * paragraph, while it can be edited. It is drawn by the design package's rule
 * for `data-placeholder` and by nothing of the application's.
 *
 * It is a decoration, so it is no content: not in the document, not sent to
 * another client, not copied. It is an element of its own, hidden from a
 * screen reader, and not the attribute on the paragraph: the description of
 * the text says the same sentence, and text that a stylesheet generates
 * cannot be hidden, so a screen reader would read it twice, the second time
 * as the first line of the document (NFR-IC-19).
 */
const EmptyPrompt = Extension.create({
  name: 'emptyPrompt',
  addProseMirrorPlugins() {
    const { editor } = this;
    const prompt = (view: EditorView) => {
      const element = view.dom.ownerDocument.createElement('span');
      element.setAttribute('aria-hidden', 'true');
      element.setAttribute('data-placeholder', SLASH_HINT);
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

const lowlight = createLowlight(common);

/**
 * The longest code block that is shown with the colours of its language, in
 * characters. A longer one is shown without them, and is the same block in
 * every other way: nothing of its content or its language changes, and it
 * gains its colours again when it is shortened.
 *
 * AWAITS THE OWNER (the decision of 12 October 2026 leaves the number to the
 * measurements; its register row is pending). The library colours every code
 * block of the document again at each keystroke in any of them. Measured in
 * Chromium on 12 October 2026, one keystroke in a block of JavaScript: 27 ms
 * at 10 KB, 96 ms at 50 KB, 172 ms at 100 KB, 434 ms at 250 KB and 1.8 s at
 * 1 MB; without colours 5, 8, 11, 28 and 82 ms. So the bound is where a
 * keystroke still answers within a tenth of a second.
 *
 * ponytail: the bound is on one block, and the cost is the sum of all of
 * them: two hundred blocks of 25 KB are coloured in full at each keystroke. A
 * bound on the code of the whole document, or a plugin that colours only the
 * block that changed, if a document of many long blocks is ever written.
 */
export const CODE_COLOURS_MOST = 50_000;
// What the library reads from an answer: the nodes to colour. None.
const UNCOLOURED = { type: 'root', children: [] };
/** `lowlight`, which answers with no colours for code past the bound. */
export const codeColours = {
  ...lowlight,
  highlight: (language: string, code: string) =>
    code.length > CODE_COLOURS_MOST ? UNCOLOURED : lowlight.highlight(language, code),
  highlightAuto: (code: string) =>
    code.length > CODE_COLOURS_MOST ? UNCOLOURED : lowlight.highlightAuto(code),
};

/**
 * The extensions of the editor, bound to the document of one connection.
 * `unshown` is told, once, that the document cannot be built here (`holdBinding`).
 */
export function extensions(document: Y.Doc, unshown: () => void = () => {}) {
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
    }).configure({ lowlight: codeColours, defaultLanguage: 'plaintext' }),
    Callout,
    TableOfContents,
    PageBreak,
    // A table stands only inside its block, with its caption. Bounded, so
    // that no table a client sends is too large to lay out (`TABLE_MOST`): a
    // row or a cell past the bound is not content of this schema, and is left
    // out as a node without a type is (`closeSchema`).
    Table.extend({ group: '', content: `tableRow{1,${TABLE_MOST}}` }),
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
    Collaboration.extend({
      addProseMirrorPlugins() {
        const plugins = this.parent?.() ?? [];
        // The binding is held before its plugin starts it, as the library
        // itself reaches the plugin of undo: by the function that starts it.
        const sync = plugins.find((plugin) => plugin.spec.key === ySyncPluginKey);
        const start = sync?.spec.view;
        if (!sync || !start) throw new Error('editor: the collaboration binding was not found');
        sync.spec.view = (view) => {
          holdBinding(view, unshown);
          return start(view);
        };
        return plugins;
      },
    }).configure({ document, field: FRAGMENT_NAME }),
    Closed,
    Shortcuts,
    MarkdownInput,
    SlashPalette,
  ];
}
