// What a tab wrote that the server never took (F14-2; docs/plan/presence-row.md,
// section 2.4): when the role of a connection is changed to one that cannot
// edit, changes the tab holds and the server did not receive are discarded, and
// the tab offers to copy the words in them.
//
// The changes of a tab are the structs of its own client identifier, and the
// ones the server took are those below the clock at which every change of the
// tab was last acknowledged. So the unsaved words are the text of the document
// that this client wrote from that clock on and that still stands, read from
// the document in the order it stands. Formatting, deletions and where the
// words stand are not offered (register row PR-6).
//
// Nothing here reads a setting or is of the browser or of Node.js.
import * as Y from 'yjs';

/**
 * The passages of text that `client` wrote at or after `from` (the next clock of
 * the client at the last moment all its changes were acknowledged) in the
 * fragment `root`, each a run of words with nothing of anyone else's or of its
 * own acknowledged text in the middle, joined by a blank line. '' where there are none.
 */
export function unsentText(root: Y.XmlFragment | Y.XmlText, client: number, from: number): string {
  const passages: string[] = [];
  walk(root, client, from, passages);
  return passages.join('\n\n');
}

function walk(type: Y.XmlFragment | Y.XmlText, client: number, from: number, passages: string[]): void {
  if (type instanceof Y.XmlText) return passagesOf(type, client, from, passages);
  for (let item = type._start; item; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentType)
      walk(item.content.type as Y.XmlFragment | Y.XmlText, client, from, passages);
  }
}

function passagesOf(text: Y.XmlText, client: number, from: number, passages: string[]): void {
  let run = '';
  const end = () => {
    if (run) passages.push(run);
    run = '';
  };
  for (let item = text._start; item; item = item.right) {
    // A deleted run and a mark (bold, a link) stand between words without breaking them.
    if (item.deleted || item.content instanceof Y.ContentFormat) continue;
    // One struct may hold acknowledged text and, after it, unsent text: a merged run of keys.
    const mine =
      item.content instanceof Y.ContentString && item.id.client === client
        ? item.content.str.slice(Math.max(0, from - item.id.clock))
        : '';
    if (mine) run += mine;
    else end();
  }
  end();
}
