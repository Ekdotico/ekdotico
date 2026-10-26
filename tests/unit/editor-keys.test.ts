// What the editor converts as it is typed in, which keys it answers to, and
// the rows of the slash palette (FR-ED-11 to FR-ED-14), as far as they can be
// checked without a browser. tests/e2e/editor.spec.ts presses the keys.
import { Editor, getExtensionField } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { calloutType, codeLanguage, extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { MARKDOWN_INPUT } from '../../src/app/(app)/documents/[id]/input-rules.ts';
import { REMOVED, SHORTCUTS } from '../../src/app/(app)/documents/[id]/shortcuts.ts';
import { MARKDOWN } from '../../src/lib/editor/markdown.ts';
import { matchSlashCommands, SLASH_COMMANDS, type Block } from '../../src/lib/editor/slash-commands.ts';

/** The editor's own schema and extensions, with no page to stand in. */
const editor = () =>
  new Editor({
    element: null,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    extensions: extensions(new Y.Doc()),
  });

/** What each extension of the editor gives for one of its fields. */
function declared(field: 'addKeyboardShortcuts' | 'addInputRules' | 'addPasteRules') {
  const made = editor();
  return made.extensionManager.extensions.flatMap((extension) => {
    const add = getExtensionField<(() => object) | undefined>(extension, field, {
      name: extension.name,
      options: extension.options,
      storage: made.extensionStorage[extension.name as never],
      editor: made,
      type: made.schema.nodes[extension.name] ?? made.schema.marks[extension.name] ?? null,
    });
    return add ? [{ name: extension.name, value: add() }] : [];
  });
}

describe('the Markdown input (FR-ED-14)', () => {
  // The thirteen rows of the requirement, written out here: the text before
  // the cursor once the last key of the row is pressed.
  const ROWS: [keyof typeof MARKDOWN, string, string?][] = [
    ['heading', '# ', '#'],
    ['heading', '## ', '##'],
    ['heading', '### ', '###'],
    ['bulletList', '- '],
    ['bulletList', '* '],
    ['orderedList', '1. '],
    ['blockquote', '> '],
    ['horizontalRule', '---\n'],
    ['codeBlock', '```\n'],
    ['bold', '**text**', 'text'],
    ['italic', '*text*', 'text'],
    ['strike', '~~text~~', 'text'],
    ['code', '`text`', 'text'],
  ];

  it.each(ROWS)('%s: %j converts, and by that rule alone', (rule, typed, captured) => {
    const matching = Object.entries(MARKDOWN).filter(([, pattern]) => pattern.test(typed));
    expect(matching.map(([name]) => name)).toEqual([rule]);
    if (captured) expect(MARKDOWN[rule].exec(typed)![1]).toBe(captured);
  });

  it('has one pattern for each kind of row, and no other', () => {
    expect(Object.keys(MARKDOWN).sort()).toEqual([...new Set(ROWS.map(([rule]) => rule))].sort());
  });

  it('converts a mark in the middle of a line, from its own signs', () => {
    expect(MARKDOWN.bold.exec('one **two three**')![0]).toBe('**two three**');
    expect(MARKDOWN.italic.exec('one *two* and *three*')![0]).toBe('*three*');
    expect(MARKDOWN.code.exec('call `f(x)`')![1]).toBe('f(x)');
  });

  // The four marks convert only where the opening sign stands at the start of
  // a block or after white space (\s: space, no-break space, tab), and the text
  // between the signs neither starts nor ends with white space.
  describe.each([
    ['bold', '**'],
    ['italic', '*'],
    ['strike', '~~'],
    ['code', '`'],
  ] as const)('%s, between %s', (rule, sign) => {
    const found = (typed: string) => MARKDOWN[rule].exec(typed)?.[1];
    const wrap = (inner: string) => `${sign}${inner}${sign}`;

    it('converts at the start of a block', () => {
      expect(found(wrap('text'))).toBe('text');
      expect(found(wrap('x'))).toBe('x');
      expect(found(wrap('two words'))).toBe('two words');
    });

    it.each([
      ['a space', ' '],
      ['a no-break space', ' '],
      ['a tab', '\t'],
    ])('converts after %s', (_, white) => {
      expect(found(`one${white}${wrap('text')}`)).toBe('text');
      expect(found(`one two${white}${wrap('two words')}`)).toBe('two words');
    });

    it.each([
      ['a letter', 'a'],
      ['a digit', '1'],
      ['a full stop', 'a.'],
      ['an opening bracket, which is not white space', '('],
      ['a word of its own', 'snake'],
    ])('does not convert after %s', (_, before) => {
      expect(found(`${before}${wrap('b')}`)).toBeUndefined();
      expect(found(`one ${before}${wrap('text')}`)).toBeUndefined();
    });

    it('does not convert text that starts or ends with white space', () => {
      for (const inner of [' x ', ' x', 'x ', ' ', ' x', 'x\t', '  ']) {
        expect(found(wrap(inner))).toBeUndefined();
        expect(found(`a ${wrap(inner)}`)).toBeUndefined();
      }
      expect(found(`5 ${sign} 3 ${sign}`)).toBeUndefined();
    });

    it('does not convert empty text', () => {
      expect(found(`${sign}${sign}`)).toBeUndefined();
    });
  });

  it('leaves the examples of the owner as typed', () => {
    for (const typed of ['5 * 3 *', 'a ** b **', '~~ x ~~', 'snake*case*', 'a*b*', '1*2*', '(*x*']) {
      expect(Object.entries(MARKDOWN).filter(([, pattern]) => pattern.test(typed))).toEqual([]);
    }
  });

  // What the library's own rules convert and the requirement does not list,
  // every row one key short or one key over, and what could carry an address.
  it.each([
    '+ ',
    '2. ',
    '10. ',
    '1) ',
    '#### ',
    ' # ',
    '#',
    '#text ',
    'a # ',
    '-',
    '-- ',
    'a - ',
    '>',
    '---',
    '--- ',
    '----\n',
    '—-',
    '___ ',
    '___\n',
    '*** ',
    '***\n',
    '```',
    '``` ',
    '```js\n',
    '```js ',
    '~~~\n',
    '~~~ ',
    '__text__',
    '_text_',
    '==text==',
    '**text*',
    '**text',
    '****',
    '**',
    '*text',
    '~text~',
    '~~text~',
    '``',
    '``text``',
    '``text`',
    '`text',
    '> text',
    '1. text',
    '- text',
    '# text',
    '[x](javascript:alert(1))',
    '[x](https://example.com)',
    '<https://example.com>',
    'https://example.com ',
    '<b>text</b>',
    '![x](https://example.com/x.png)',
    '$x$',
    '- [ ] ',
    '[ ] ',
  ])('leaves %j as it was typed', (typed) => {
    expect(Object.entries(MARKDOWN).filter(([, pattern]) => pattern.test(typed))).toEqual([]);
  });

  it('gives a heading a level of one, two or three, and nothing else that was typed', () => {
    for (const typed of ['# ', '## ', '### ']) {
      expect(MARKDOWN.heading.exec(typed)![1]!.length).toBe(typed.length - 1);
    }
  });

  it('is the one extension whose input rules the editor may turn on', () => {
    const rules = declared('addInputRules');
    expect(rules.map(({ name }) => name)).toContain(MARKDOWN_INPUT);
    expect(rules.find(({ name }) => name === MARKDOWN_INPUT)!.value).toHaveLength(10);
  });

  // The rules as the editor runs them: the last key of a row handed to the
  // library's plugin, in an editor that has turned on these rules alone.
  function typing(content: object[], at: string) {
    const made = new Editor({
      element: null,
      content: { type: 'doc', content },
      extensions: extensions(new Y.Doc()),
      enableInputRules: [MARKDOWN_INPUT],
      enablePasteRules: false,
    });
    made.view.updateState(made.state.reconfigure({ plugins: made.extensionManager.plugins }));
    let end = -1;
    made.state.doc.descendants((node, pos) => {
      if (end < 0 && node.type.name === at) end = pos + node.nodeSize - 1;
    });
    made.commands.setTextSelection(end);
    const rules = made.state.plugins.find((plugin) => plugin.props.handleTextInput)!;
    /** Types one character at the cursor. True where a rule took it. */
    const key = (character: string) => {
      const { from, to } = made.state.selection;
      const taken = rules.props.handleTextInput!.call(rules, made.view, from, to, character, () =>
        made.state.tr.insertText(character, from, to),
      );
      if (!taken) made.view.dispatch(made.state.tr.insertText(character, from, to));
      return taken === true;
    };
    return { made, key };
  }
  const text = (written: string) => ({ type: 'text', text: written });
  const SIGNS: [string, string, string][] = [
    ['bold', '**kept*', '*'],
    ['italic', '*kept', '*'],
    ['strike', '~~kept~', '~'],
    ['code', '`kept', '`'],
  ];

  it.each(SIGNS)('%s: the closing sign converts in a paragraph', (mark, before, last) => {
    const { made, key } = typing([{ type: 'paragraph', content: [text(before)] }], 'paragraph');
    expect(key(last)).toBe(true);
    expect(made.state.doc.textContent).toBe('kept');
    expect(made.state.doc.firstChild!.firstChild!.marks.map(({ type }) => type.name)).toEqual([mark]);
  });

  // FR-ED-09, Build phases: "the caption is plain text". It takes no mark, so
  // a conversion there would take the signs and give nothing for them.
  it.each(SIGNS)(
    '%s: the closing sign converts nothing in a caption, which keeps its signs',
    (_, before, last) => {
      const table = {
        type: 'tableBlock',
        content: [
          {
            type: 'table',
            content: [
              { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] },
            ],
          },
          { type: 'tableCaption', content: [text(before)] },
        ],
      };
      const { made, key } = typing([table], 'tableCaption');
      expect(key(last)).toBe(false);
      expect(made.state.doc.textContent).toBe(before + last);
      made.state.doc.descendants((node) => expect(node.marks).toEqual([]));
    },
  );

  // Every pattern is tried at every key, on the text of the block before the
  // cursor. Each is linear in that text today. A later pattern with a
  // quantifier inside a quantifier would take seconds on these lines.
  it.each(Object.entries(MARKDOWN))('%s reads a line of 100 KB in a few milliseconds', (_, pattern) => {
    const LINES = [
      ...[
        '*',
        '`',
        '~',
        '#',
        '-',
        '_',
        ' ',
        'a',
        '> ',
        '1. ',
        '* ',
        '** ',
        '**a ',
        ' *a',
        'a*',
        '~~a ',
        '`a ',
      ].map((unit) => unit.repeat(Math.ceil(100_000 / unit.length))),
      `**${'a '.repeat(50_000)}`,
      `*${'a'.repeat(100_000)}`,
      `${'a '.repeat(50_000)}**`,
      `~~${'a~ '.repeat(33_000)}`,
    ];
    const at = performance.now();
    for (const line of LINES)
      for (const end of ['', '*', '**', '~~', '`', ' ', '\n', 'z']) pattern.test(line + end);
    expect(performance.now() - at).toBeLessThan(500);
  });
});

describe('the keyboard shortcuts (FR-ED-13)', () => {
  // The requirement's rows without the comment shortcut (Build phases), written out here.
  const LIST = [
    'Mod-b', // Toggle bold
    'Mod-i', // Toggle italic
    'Mod-u', // Toggle underline
    'Mod-Shift-s', // Toggle strikethrough
    'Mod-`', // Toggle inline code
    'Mod-k', // Insert or edit hyperlink
    'Mod-z', // Undo
    'Mod-Shift-z', // Redo
    'Tab', // Indent list item
    'Shift-Tab', // Outdent list item
  ];
  // What a person edits text with, beside the list: the library's keys for
  // deleting, for a line break, for selecting everything, the ones macOS adds
  // for the caret, and redo as Windows writes it.
  const EDITING = ['Mod-Enter', 'Mod-Backspace', 'Mod-Delete', 'Mod-a', 'Mod-y'];
  // The keys macOS adds for the caret. The library binds them on macOS alone,
  // by the platform the process reports, so the editor answers to them there
  // and nowhere else: CI runs on Linux.
  const MAC_EDITING = [
    'Ctrl-h',
    'Alt-Backspace',
    'Ctrl-d',
    'Ctrl-Alt-Backspace',
    'Alt-Delete',
    'Alt-d',
    'Ctrl-a',
    'Ctrl-e',
  ];
  // One writing for each key: the modifiers in one order, and a letter as it is without Caps Lock.
  const normal = (chord: string) => {
    const parts = chord.split('-');
    const key = parts.pop()!;
    const modifiers = ['Mod', 'Ctrl', 'Alt', 'Shift'].filter((each) => parts.includes(each));
    return [...modifiers, key.length === 1 ? key.toLowerCase() : key].join('-');
  };
  const modified = (chord: string) => /^(Mod|Ctrl|Alt)-/.test(chord);
  const bound = () => [
    ...new Set(declared('addKeyboardShortcuts').flatMap(({ value }) => Object.keys(value).map(normal))),
  ];

  it('is the list of the requirement', () => {
    expect([...SHORTCUTS]).toEqual(LIST);
  });

  it('binds every key of the list', () => {
    for (const chord of LIST) expect(bound(), chord).toContain(normal(chord));
  });

  it('removes no key of the list, and none a person edits text with', () => {
    for (const chord of [...LIST, ...EDITING, ...MAC_EDITING])
      expect(REMOVED.map(normal), chord).not.toContain(normal(chord));
  });

  // The rule: of the keys pressed with Ctrl, Cmd or Alt, the editor answers
  // to the list, to the editing keys above, and to nothing else. A release of
  // the library that binds another fails here until the key is placed.
  it('answers to no key with a modifier beyond the list and the keys of editing', () => {
    const left = bound()
      .filter(modified)
      .filter((chord) => !REMOVED.map(normal).includes(chord));
    const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
    const editing = mac ? [...EDITING, ...MAC_EDITING] : EDITING;
    expect(left.sort()).toEqual([...LIST.filter(modified), ...editing].map(normal).sort());
  });

  it('removes only keys that the library binds', () => {
    for (const chord of REMOVED) expect(bound(), chord).toContain(normal(chord));
  });
});

describe('the rows of the slash palette (FR-ED-11, FR-ED-12)', () => {
  // FR-ED-12, the rows for the block types the editor holds, in its order.
  const ROWS: [string, string[], string][] = [
    ['text', ['p', 'paragraph'], 'paragraph'],
    ['h1', ['heading1'], 'heading'],
    ['h2', ['heading2'], 'heading'],
    ['h3', ['heading3'], 'heading'],
    ['bullet', ['ul', 'unordered'], 'bulletList'],
    ['numbered', ['ol', 'ordered'], 'orderedList'],
    ['quote', ['blockquote'], 'blockquote'],
    ['table', [], 'tableBlock'],
    ['code', ['codeblock'], 'codeBlock'],
    ['image', ['img'], 'image'],
    ['callout', ['note'], 'callout'],
    // FR-ED-12: "Footnote block", read as the owner decided on Q16 (c): the marker, with its entry made.
    ['footnote', ['fn'], 'footnoteReference'],
    ['toc', ['contents'], 'tableOfContents'],
    ['divider', ['hr', 'rule'], 'horizontalRule'],
    ['page-break', ['pagebreak'], 'pageBreak'],
  ];
  // The rows of the requirement that are another slice's, or not in α 0.1.0.
  const NOT_HERE = ['latex', 'math', 'equation', 'mermaid', 'diagram', 'cite'];

  it('are the rows of the requirement for the blocks of the cut, with their aliases', () => {
    expect(SLASH_COMMANDS.map(({ name, aliases, inserts }) => [name, [...aliases], inserts.type])).toEqual(
      ROWS,
    );
  });

  it('hold no row for a block of another slice or outside the release', () => {
    const words = SLASH_COMMANDS.flatMap(({ name, aliases }) => [name, ...aliases]);
    for (const word of NOT_HERE) {
      expect(words).not.toContain(word);
      expect(matchSlashCommands(word)).toEqual([]);
    }
    const types = new Set<string>();
    const walk = (block: Block) => {
      types.add(block.type);
      block.content?.forEach(walk);
    };
    SLASH_COMMANDS.forEach(({ inserts }) => walk(inserts));
    for (const type of ['latex', 'mermaid', 'citation']) {
      expect(types).not.toContain(type);
    }
  });

  it('give no word to two commands', () => {
    const words = SLASH_COMMANDS.flatMap(({ name, aliases }) => [name, ...aliases]);
    expect(new Set(words).size).toBe(words.length);
  });

  it.each(SLASH_COMMANDS.map((command) => [command.name, command] as const))(
    '/%s inserts a block the schema takes whole, with every attribute at a value of its list',
    (_, { inserts }) => {
      const { schema } = editor();
      const node = schema.nodeFromJSON(inserts);
      // Throws where a child is missing, misplaced, or of a type the parent does not take.
      node.check();
      // A block, and one that can stand in the document; or the footnote's marker, which is inline
      // and stands in a paragraph.
      const container = node.type.isInline ? schema.nodes.paragraph! : schema.topNodeType;
      expect(container.contentMatch.matchType(node.type)).not.toBeNull();
      // Every attribute written is one the node has, and is held as written.
      const same = (block: Block, held: typeof node) => {
        expect(held.type.name).toBe(block.type);
        expect(held.attrs).toMatchObject(block.attrs ?? {});
        block.content?.forEach((child, index) => same(child, held.child(index)));
      };
      same(inserts, node);
    },
  );

  // The collaboration server validates no content, so an attribute is held to
  // its node's own list wherever it is written. The palette writes three.
  it('writes three attributes in all, each a value of the closed list its node reads it through', () => {
    const written: [string, string, string | number][] = [];
    const walk = (block: Block) => {
      for (const [key, value] of Object.entries(block.attrs ?? {})) written.push([block.type, key, value]);
      block.content?.forEach(walk);
    };
    SLASH_COMMANDS.forEach(({ inserts }) => walk(inserts));
    expect(written).toEqual([
      ['heading', 'level', 1],
      ['heading', 'level', 2],
      ['heading', 'level', 3],
      ['codeBlock', 'language', 'plaintext'],
      ['callout', 'type', 'note'],
    ]);
    expect(codeLanguage('plaintext')).toBe('plaintext');
    expect(calloutType('note')).toBe('note');
  });

  it('inserts a table of three rows of three cells, with its caption', () => {
    const { schema } = editor();
    const block = schema.nodeFromJSON(SLASH_COMMANDS.find(({ name }) => name === 'table')!.inserts);
    const [table, caption] = block.children;
    expect(table!.childCount).toBe(3);
    table!.forEach((row) => {
      expect(row.childCount).toBe(3);
      row.forEach((cell) => expect(cell.attrs).toMatchObject({ colspan: 1, rowspan: 1 }));
    });
    expect(caption!.type.name).toBe('tableCaption');
  });

  it('lists every command where nothing is typed, in the order of the requirement', () => {
    expect(matchSlashCommands('').map(({ name }) => name)).toEqual(ROWS.map(([name]) => name));
  });

  it.each([
    ['h', ['h1', 'h2', 'h3', 'divider']],
    ['h2', ['h2']],
    ['heading', ['h1', 'h2', 'h3']],
    ['p', ['text', 'page-break']],
    ['ul', ['bullet']],
    ['OL', ['numbered']],
    ['Note', ['callout']],
    ['co', ['code', 'toc']],
    ['c', ['code', 'callout', 'toc']],
    ['rule', ['divider']],
    ['pagebreak', ['page-break']],
    ['page-', ['page-break']],
    ['table', ['table']],
    ['x', []],
    ['h4', []],
    ['text ', []],
    ['/', []],
  ])('typing %j leaves %j', (typed, names) => {
    expect(matchSlashCommands(typed).map(({ name }) => name)).toEqual(names);
  });
});
