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
// The collaboration server does not read content, so every attribute of every
// node and mark that arrives is hostile, whatever its type. Each attribute the
// schema defines has one rule in `ATTRIBUTE_RULES` below, a closed list or a
// bounded number, and the rule is applied where the schema makes a node or a
// mark (`closeAttributes`): a plugin, a node view and `renderHTML` are all
// handed the value the rule returned, and never the one that arrived. A value
// outside its rule becomes the default; nothing throws.
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
import type { Schema } from '@tiptap/pm/model';
import { Plugin, type Transaction } from '@tiptap/pm/state';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type Editor,
  type NodeViewProps,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { common, createLowlight } from 'lowlight';
import type * as Y from 'yjs';
import { Button, MenuButton, RadioGroup, Select } from '@ekdotico/domico/components';
import { LightbulbIcon, StickyNoteIcon, TriangleAlertIcon } from '@ekdotico/domico/icons';
import { FRAGMENT_NAME } from '../../../../lib/collab/protocol.ts';
import { linkAddress } from '../../../../lib/editor/link.ts';
import styles from './editor.module.css';

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
          label="Language"
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
  { value: '2', label: 'Levels 1 and 2' },
  { value: '3', label: 'Levels 1 to 3' },
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
        <p>No headings yet. Each heading of the document is listed here.</p>
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

/**
 * Has the schema apply the rules wherever it makes a node or a mark: from a
 * change of another client, from a paste, from a command, from JSON. The
 * library has no place to say this, so the one function through which each
 * type computes its attributes is wrapped (`NodeType.computeAttrs`, which
 * prosemirror-model 1.25.12 does not declare, and `MarkType.create`). The
 * test of this file's rules fails if an upgrade moves either.
 */
export function closeAttributes(schema: Schema): Schema {
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

const Closed = Extension.create({
  name: 'closed',
  onBeforeCreate() {
    closeAttributes(this.editor.schema);
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (transaction) => mayApply(transaction, this.editor.isEditable),
      }),
    ];
  },
});

// ── The whole schema ────────────────────────────────────────────────────────

const lowlight = createLowlight(common);

/** The extensions of the editor, bound to the document of one connection. */
export function extensions(document: Y.Doc) {
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
    }).configure({ lowlight, defaultLanguage: 'plaintext' }),
    Callout,
    TableOfContents,
    PageBreak,
    // A table stands only inside its block, with its caption. Bounded, so
    // that no table a client sends is too large to lay out (`TABLE_MOST`): one
    // past the bound is not content of this schema, as a node without a type is not.
    Table.extend({ group: '', content: `tableRow{1,${TABLE_MOST}}` }),
    TableRow.extend({ content: `(tableCell | tableHeader){0,${TABLE_MOST}}` }),
    TableHeader,
    TableCell,
    TableBlock,
    TableCaption,
    Placeholder.configure({
      showOnlyCurrent: false,
      placeholder: ({ node, editor }) =>
        node.type.name === 'tableCaption' ? 'Caption' : editor.isEmpty ? 'Write the document here' : '',
    }),
    Collaboration.configure({ document, field: FRAGMENT_NAME }),
    Closed,
  ];
}
