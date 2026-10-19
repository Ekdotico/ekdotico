// The words a tab wrote that the server never took (F14-2; src/lib/collab/unsent.ts):
// read from the document by the clock at which all the tab's changes were last acknowledged.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { unsentText } from '../../src/lib/collab/unsent.ts';

/** A paragraph with its text, as the editor's binding writes one: an element holding a text. */
function paragraph(text: string): Y.XmlElement {
  const element = new Y.XmlElement('paragraph');
  const body = new Y.XmlText();
  element.insert(0, [body]);
  if (text) body.insert(0, text);
  return element;
}
const textOf = (element: Y.XmlElement) => element.get(0) as Y.XmlText;
/** The clock this client has reached: what it had written when "everything was acknowledged". */
const clockOf = (doc: Y.Doc) => Y.getState(doc.store, doc.clientID);

/** Two clients on one document, as a tab and the rest of the world; `sync` plays the server between them. */
function pair() {
  const mine = new Y.Doc();
  const theirs = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs, Y.encodeStateVector(mine)));
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine, Y.encodeStateVector(theirs)));
  };
  return { mine, theirs, sync, fragment: (doc: Y.Doc) => doc.getXmlFragment('default') };
}

describe('the unsent words of a tab (F14-2)', () => {
  it('is nothing where everything was acknowledged', () => {
    const { mine, fragment } = pair();
    fragment(mine).insert(0, [paragraph('Written and acknowledged.')]);
    expect(unsentText(fragment(mine), mine.clientID, clockOf(mine))).toBe('');
  });

  it('is all the words of the tab where nothing was acknowledged', () => {
    const { mine, fragment } = pair();
    fragment(mine).insert(0, [paragraph('First.'), paragraph('Second.')]);
    expect(unsentText(fragment(mine), mine.clientID, 0)).toBe('First.\n\nSecond.');
  });

  it('is the words typed after the acknowledgement, in a paragraph that was acknowledged', () => {
    const { mine, fragment } = pair();
    const first = paragraph('Kept. ');
    fragment(mine).insert(0, [first]);
    const acknowledged = clockOf(mine);
    textOf(first).insert(6, 'Typed offline.');
    // The struct holds both, one run of keys: only the words after the clock are the tab's unsent.
    expect(unsentText(fragment(mine), mine.clientID, acknowledged)).toBe('Typed offline.');
  });

  it('is the words of a new paragraph, and not the acknowledged text before it', () => {
    const { mine, fragment } = pair();
    fragment(mine).insert(0, [paragraph('Acknowledged.')]);
    const acknowledged = clockOf(mine);
    fragment(mine).insert(1, [paragraph('Typed offline.')]);
    expect(unsentText(fragment(mine), mine.clientID, acknowledged)).toBe('Typed offline.');
  });

  it('keeps passages apart where acknowledged text stands between them', () => {
    const { mine, fragment } = pair();
    const paragraphOne = paragraph('Alpha beta gamma.');
    fragment(mine).insert(0, [paragraphOne]);
    const acknowledged = clockOf(mine);
    textOf(paragraphOne).insert(0, 'ONE ');
    textOf(paragraphOne).insert(textOf(paragraphOne).length, ' TWO');
    expect(unsentText(fragment(mine), mine.clientID, acknowledged)).toBe('ONE \n\n TWO');
  });

  it('does not offer words that were deleted again', () => {
    const { mine, fragment } = pair();
    const first = paragraph('');
    fragment(mine).insert(0, [first]);
    const acknowledged = clockOf(mine);
    textOf(first).insert(0, 'Typed and removed.');
    textOf(first).delete(0, textOf(first).length);
    textOf(first).insert(0, 'Kept.');
    expect(unsentText(fragment(mine), mine.clientID, acknowledged)).toBe('Kept.');
  });

  it('never offers the text of another client, in the middle of the tab’s own or elsewhere', () => {
    const { mine, theirs, sync, fragment } = pair();
    fragment(mine).insert(0, [paragraph('Mine, acknowledged.')]);
    sync();
    const acknowledged = clockOf(mine);
    // Another client writes in the same paragraph and in its own.
    textOf(fragment(theirs).get(0) as Y.XmlElement).insert(0, 'THEIRS ');
    fragment(theirs).insert(1, [paragraph('Their paragraph.')]);
    sync();
    textOf(fragment(mine).get(0) as Y.XmlElement).insert(0, 'mine, unsent ');
    const offered = unsentText(fragment(mine), mine.clientID, acknowledged);
    expect(offered).toBe('mine, unsent ');
    expect(offered).not.toContain('THEIRS');
    expect(offered).not.toContain('Their paragraph.');
  });

  it('reads through the marks that stand between words', () => {
    const { mine, fragment } = pair();
    const first = paragraph('');
    fragment(mine).insert(0, [first]);
    const acknowledged = clockOf(mine);
    textOf(first).insert(0, 'plain ');
    textOf(first).insert(6, 'bold', { bold: true });
    textOf(first).insert(10, ' plain');
    expect(unsentText(fragment(mine), mine.clientID, acknowledged)).toBe('plain bold plain');
  });

  it('reads text in a block inside a block, such as a list item in a list', () => {
    const { mine, fragment } = pair();
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    list.insert(0, [item]);
    fragment(mine).insert(0, [list]);
    const acknowledged = clockOf(mine);
    item.insert(0, [paragraph('An item typed offline.')]);
    expect(unsentText(fragment(mine), mine.clientID, acknowledged)).toBe('An item typed offline.');
  });

  it('counts a character outside the first plane as one, whole', () => {
    const { mine, fragment } = pair();
    const first = paragraph('');
    fragment(mine).insert(0, [first]);
    const acknowledged = clockOf(mine);
    textOf(first).insert(0, 'ΕΛΛΑΔΑ 😀');
    expect(unsentText(fragment(mine), mine.clientID, acknowledged)).toBe('ΕΛΛΑΔΑ 😀');
  });
});
