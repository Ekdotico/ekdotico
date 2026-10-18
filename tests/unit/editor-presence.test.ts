// The cursors of the others, as the editor draws them (FR-ED-17;
// src/app/(app)/documents/[id]/cursors.ts): what is drawn from a state of
// awareness, and what is not. There is no DOM here, so the caret is built on a
// stand-in for `document` that records what is set on each element, and the
// colour of each slot, which only a browser can show, is the end-to-end test's
// (tests/e2e/editor.spec.ts).
import { Awareness } from 'y-protocols/awareness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { caretOf, drawn, selectionOf } from '../../src/app/(app)/documents/[id]/cursors.ts';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { COLLABORATOR_COLOURS } from '../../src/lib/collab/presence.ts';

// The stylesheet of the editor names a class for each slot: here each name is its own, so that a test can read it.
vi.mock('../../src/app/(app)/documents/[id]/editor.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => String(name) }),
}));

/** What an element is, as far as the caret sets it. */
interface Fake {
  tag: string;
  className: string;
  textContent: string;
  attributes: Record<string, string>;
  children: Fake[];
  setAttribute(name: string, value: string): void;
  append(...nodes: Fake[]): void;
}
const made: Fake[] = [];
beforeEach(() => {
  made.length = 0;
  vi.stubGlobal('document', {
    createElement: (tag: string): Fake => {
      const element: Fake = {
        tag,
        className: '',
        textContent: '',
        attributes: {},
        children: [],
        setAttribute: (name, value) => (element.attributes[name] = value),
        append: (...nodes) => element.children.push(...nodes),
      };
      made.push(element);
      return element;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const caret = (user: unknown) => caretOf(user) as unknown as Fake;

describe('the caret and the label of another person', () => {
  it('draws the name as text, in the label above the caret, in the class of the slot', () => {
    const drawing = caret({ name: 'Ada Owner', slot: 3 });
    expect(drawing.className.split(' ')).toEqual(['caret', 'slot3']);
    expect(drawing.children).toHaveLength(1);
    expect(drawing.children[0]).toMatchObject({ className: 'label', textContent: 'Ada Owner' });
  });

  it('draws a slot of each of the colours, in its own class', () => {
    for (let slot = 1; slot <= COLLABORATOR_COLOURS; slot++) {
      expect(caret({ name: 'x', slot }).className).toContain(`slot${slot}`);
      expect(selectionOf({ name: 'x', slot })).toEqual({ class: `selection${slot}` });
    }
  });

  it('is not read to a screen reader: a name inside the text would be read as part of it', () => {
    expect(caret({ name: 'Ada', slot: 1 }).attributes['aria-hidden']).toBe('true');
  });

  // A name is a person's, and a person can choose anything for it: it is text, never markup.
  it('sets a name as text and never as markup', () => {
    const name = '<img src=x onerror=alert(1)>';
    const drawing = caret({ name, slot: 2 });
    expect(drawing.children[0]!.textContent).toBe(name);
    // Only `createElement` and `textContent` build it: nothing is parsed.
    expect(made.map((each) => each.tag)).toEqual(['span', 'span']);
  });
});

describe('who is drawn', () => {
  const state = (user: unknown) => ({ user });

  it('is each other client that says a name and a slot of the colour set', () => {
    expect(drawn(1, 2, state({ name: 'Ada', slot: 1 }))).toBe(true);
    expect(drawn(1, 2, state({ name: 'Ada', slot: COLLABORATOR_COLOURS }))).toBe(true);
  });

  it('is not this client', () => {
    expect(drawn(1, 1, state({ name: 'Ada', slot: 1 }))).toBe(false);
  });

  it.each([
    ['no state', null],
    ['no user', {}],
    ['a user that is text', state('Ada')],
    ['a user with no name', state({ slot: 1 })],
    ['a user with an empty name', state({ name: '', slot: 1 })],
    ['a name that is not text', state({ name: 5, slot: 1 })],
    ['no slot', state({ name: 'Ada' })],
    ['a slot of 0', state({ name: 'Ada', slot: 0 })],
    ['a slot past the colours', state({ name: 'Ada', slot: COLLABORATOR_COLOURS + 1 })],
    ['a slot that is text', state({ name: 'Ada', slot: '1' })],
    ['a slot that is not whole', state({ name: 'Ada', slot: 1.5 })],
  ])(
    'is not a person with %s: a colour with no name is a defect, and a name with no colour is not drawn',
    (_, value) => {
      expect(drawn(1, 2, value)).toBe(false);
    },
  );
});

describe('the extension', () => {
  const names = (reads: boolean, awareness: Awareness | null) =>
    extensions(
      new Y.Doc(),
      () => {},
      () => {},
      () => {},
      reads,
      awareness,
    ).map((each) => each.name);

  it('is in the editor of a browser that can edit, where there is awareness, and nowhere else', () => {
    const awareness = new Awareness(new Y.Doc());
    expect(names(false, awareness)).toContain('cursors');
    // A browser that cannot edit has no binding for it to draw from (D185; S14-1).
    expect(names(true, awareness)).not.toContain('cursors');
    expect(names(false, null)).not.toContain('cursors');
    awareness.destroy();
  });
});
