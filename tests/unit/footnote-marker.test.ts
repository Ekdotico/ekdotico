// The marker as the page draws it and the way from it to its entry (FR-ED-05, NFR-IC-19; docs/plan/slice-20.md,
// section 6). The tests of the editor run with no page, so the elements here are stand-ins that keep what
// the view sets on them; tests/e2e/footnotes.spec.ts reads the same of a browser.
import { Editor } from '@tiptap/core';
import { DOMSerializer, type Node as PMNode } from '@tiptap/pm/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import {
  ENTRY_PROMPT,
  FOOTNOTES_NAME,
  followMarker,
  markerName,
  markerView,
} from '../../src/app/(app)/documents/[id]/footnotes.ts';

const ID = '0123456789abcdef01234567';

class Fake {
  children: Fake[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, (event: { preventDefault(): void }) => void> = {};
  hidden = false;
  href = '';
  textContent = '';
  tabIndex = 0;
  scrolled: unknown[] = [];
  focused: unknown[] = [];
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  append(child: Fake) {
    this.children.push(child);
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
    if (name === 'tabindex') this.tabIndex = 0;
  }
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) {
    this.listeners[type] = listener;
  }
  scrollIntoView(options: unknown) {
    this.scrolled.push(options);
  }
  focus(options: unknown) {
    this.focused.push(options);
  }
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => new Fake(tag) });
  vi.stubGlobal('HTMLElement', Fake);
});
afterEach(() => vi.unstubAllGlobals());

/** An editor holding a marker and its entry, and a stand-in for what its view says of their elements. */
function editorOf() {
  const made = new Editor({
    element: null,
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'footnoteReference', attrs: { id: ID } }] },
        {
          type: 'footnotes',
          content: [{ type: 'footnote', attrs: { id: ID }, content: [{ type: 'text', text: 'note' }] }],
        },
      ],
    },
    extensions: extensions(new Y.Doc()),
  });
  made.view.updateState(made.state.reconfigure({ plugins: made.extensionManager.plugins }));
  return made;
}
const marker = (editor: Editor): PMNode => editor.state.doc.firstChild!.firstChild!;
const view = (editor: Editor, node: PMNode = marker(editor)) =>
  markerView({ node, editor }) as unknown as {
    dom: Fake;
    update(node: PMNode, decorations: readonly { spec: object }[]): boolean;
    stopEvent(event: Event): boolean;
    ignoreMutation(): boolean;
  };
const numbered = (footnoteNumber: number) => [{ spec: { footnoteNumber } }];

describe('the view of a marker', () => {
  it('is a superscript link to its entry, named by its number, which is its visible text (WCAG 2.5.3)', () => {
    const editor = editorOf();
    const drawn = view(editor);
    drawn.update(marker(editor), numbered(3));
    const [link] = drawn.dom.children;
    expect(drawn.dom.tag).toBe('sup');
    expect(link!.tag).toBe('a');
    expect(link!.textContent).toBe('3');
    expect(link!.attributes['aria-label']).toBe('Footnote 3');
    expect(link!.attributes['aria-label']).toContain(link!.textContent);
    expect(link!.attributes.role).toBe('doc-noteref');
    expect(link!.href).toBe(`#footnote-${ID}`);
    expect(drawn.dom.hidden).toBe(false);
    expect(markerName(7)).toBe('Footnote 7');
  });

  it('is drawn with the number it is made with: the page hands the decorations to the view at its making, and calls no update after', () => {
    const editor = editorOf();
    const made = markerView({
      node: marker(editor),
      editor,
      decorations: numbered(4) as never,
    }) as unknown as { dom: Fake };
    expect(made.dom.hidden).toBe(false);
    expect(made.dom.children[0]!.textContent).toBe('4');
    expect(made.dom.children[0]!.attributes['aria-label']).toBe('Footnote 4');
  });

  it('is a stop of Tab in the text and where the document cannot be edited: the way from the keyboard to its entry', () => {
    const editor = editorOf();
    const drawn = view(editor);
    expect(drawn.dom.children[0]!.tabIndex).toBe(0);
    drawn.update(marker(editor), numbered(1));
    expect(drawn.dom.children[0]!.tabIndex).toBe(0);
    editor.setEditable(false);
    drawn.update(marker(editor), numbered(1));
    expect(drawn.dom.children[0]!.tabIndex).toBe(0);
  });

  it('leaves the keys pressed on the link to the browser: Enter on it follows it and splits no paragraph', () => {
    const editor = editorOf();
    const drawn = view(editor);
    const stops = (type: string) => drawn.stopEvent({ type } as Event);
    expect(stops('keydown')).toBe(true);
    expect(stops('keyup')).toBe(true);
    expect(stops('keypress')).toBe(true);
    // A press of the pointer on it is the editor's, which puts the cursor where it was pressed.
    expect(stops('mousedown')).toBe(false);
    expect(stops('click')).toBe(false);
  });

  it('is drawn again with the number the document gives it, whatever it drew before', () => {
    const editor = editorOf();
    const drawn = view(editor);
    drawn.update(marker(editor), numbered(1));
    expect(drawn.dom.children[0]!.textContent).toBe('1');
    drawn.update(marker(editor), numbered(12));
    expect(drawn.dom.children[0]!.textContent).toBe('12');
    expect(drawn.dom.children[0]!.attributes['aria-label']).toBe('Footnote 12');
  });

  it('is not shown where it has no number, and where it holds no identifier of the form: nothing links to it', () => {
    const editor = editorOf();
    const drawn = view(editor);
    drawn.update(marker(editor), []);
    expect(drawn.dom.hidden).toBe(true);
    const stripped = editor.schema.nodes.footnoteReference!.create({ id: null });
    expect(drawn.update(stripped, numbered(1))).toBe(true);
    expect(drawn.dom.hidden).toBe(true);
    drawn.update(marker(editor), numbered(1));
    expect(drawn.dom.hidden).toBe(false);
  });

  it('is a view of its own kind only, and lets the page change its elements without reading them as the writer’s', () => {
    const editor = editorOf();
    const drawn = view(editor);
    expect(drawn.update(editor.state.doc.firstChild!, [])).toBe(false);
    expect(drawn.ignoreMutation()).toBe(true);
  });
});

describe('the way from a marker to its entry (FR-ED-05)', () => {
  it('puts the cursor at the end of the entry and scrolls to it, where the document can be edited', () => {
    const editor = editorOf();
    const entry = new Fake('li');
    const chained: string[] = [];
    const chain = {
      setTextSelection: (at: number) => (chained.push(`select ${at}`), chain),
      focus: (_: unknown, options: unknown) => (chained.push(`focus ${JSON.stringify(options)}`), chain),
      run: () => (chained.push('run'), true),
    };
    const stand = {
      state: editor.state,
      isEditable: true,
      chain: () => chain,
      view: { nodeDOM: () => entry },
    } as unknown as Editor;
    expect(followMarker(stand, ID)).toBe(true);
    // The entry stands after the paragraph, one step in; its text ends one step before its close.
    const at = editor.state.doc.firstChild!.nodeSize + 1 + 1 + 'note'.length + 0;
    expect(chained).toEqual([`select ${at}`, 'focus {"scrollIntoView":false}', 'run']);
    expect(entry.scrolled).toEqual([{ block: 'center' }]);
    expect(entry.focused).toEqual([]);
  });

  it('scrolls to the entry and gives it the focus, where the document cannot be edited', () => {
    const editor = editorOf();
    const entry = new Fake('li');
    const stand = {
      state: editor.state,
      isEditable: false,
      chain: () => {
        throw new Error('nothing is selected in a document that cannot be edited');
      },
      view: { nodeDOM: () => entry },
    } as unknown as Editor;
    expect(followMarker(stand, ID)).toBe(true);
    expect(entry.scrolled).toEqual([{ block: 'center' }]);
    expect(entry.focused).toEqual([{ preventScroll: true }]);
  });

  it('is what a click on the link does, and the browser follows no address', () => {
    const editor = editorOf();
    const entry = new Fake('li');
    const stand = {
      state: editor.state,
      isEditable: false,
      view: { nodeDOM: () => entry },
    } as unknown as Editor;
    const drawn = view(stand);
    let prevented = false;
    drawn.dom.children[0]!.listeners.click!({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(entry.scrolled).toHaveLength(1);
  });

  it('does nothing for an identifier that is not one, or whose entry is not there', () => {
    const editor = editorOf();
    const stand = {
      state: editor.state,
      isEditable: false,
      view: { nodeDOM: () => null },
    } as unknown as Editor;
    expect(followMarker(stand, 'not an identifier')).toBe(false);
    expect(followMarker(stand, null)).toBe(false);
    expect(followMarker(stand, 'f'.repeat(24))).toBe(false);
  });
});

describe('the markup that is not drawn by the view (a clipboard)', () => {
  it('holds the identifier of a marker and no link, the entry as a list item of a named region, and no more', () => {
    const editor = editorOf();
    const spec = DOMSerializer.fromSchema(editor.schema);
    // No document here: the specification of each element is read as it is.
    expect(JSON.stringify(spec.nodes.footnoteReference!(marker(editor)))).toBe(
      `["sup",{"data-footnote-id":"${ID}"}]`,
    );
    expect(JSON.stringify(spec.nodes.footnotes!(editor.state.doc.lastChild!))).toBe(
      `["section",{"role":"doc-endnotes","aria-label":"${FOOTNOTES_NAME}"},["ol",0]]`,
    );
    expect(JSON.stringify(spec.nodes.footnote!(editor.state.doc.lastChild!.firstChild!))).toBe(
      `["li",{"id":"footnote-${ID}"},0]`,
    );
    expect(FOOTNOTES_NAME).toBe('Footnotes');
    expect(ENTRY_PROMPT).toBe('Footnote text');
  });

  it('holds an identifier of the form and none that the writer of a page chose: the rule closes the markup too', () => {
    const editor = editorOf();
    const spec = DOMSerializer.fromSchema(editor.schema);
    const hostile = editor.schema.nodes.footnoteReference!.create({ id: '"><script>alert(1)</script>' });
    expect(JSON.stringify(spec.nodes.footnoteReference!(hostile))).toBe('["sup",{"data-footnote-id":""}]');
    const entry = editor.schema.nodes.footnote!.create({ id: 'javascript:alert(1)' });
    expect(JSON.stringify(spec.nodes.footnote!(entry))).toBe('["li",{},0]');
  });
});
