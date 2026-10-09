// A stored state that no client could send now: quotes nested deeper than the
// collaboration server takes (src/lib/collab/state.ts), as a document stored
// before there was a limit could hold. Written straight into the database of
// the run, for the test of what the page does with a document it cannot build.
//
//   node tests/e2e/stored-state.ts <identifier of a document> <depth>
import * as Y from 'yjs';
import { FRAGMENT_NAME } from '../../src/lib/collab/protocol.ts';
import { db } from '../../src/lib/db.ts';

const [id, depth] = process.argv.slice(2);
if (!id || !Number(depth)) throw new Error('usage: stored-state.ts <identifier of a document> <depth>');
const document = new Y.Doc();
document.transact(() => {
  let parent: Y.XmlFragment = document.getXmlFragment(FRAGMENT_NAME);
  for (let level = 1; level < Number(depth); level += 1) {
    const quote = new Y.XmlElement('blockquote');
    parent.insert(0, [quote]);
    parent = quote;
  }
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText('deep')]);
  parent.insert(0, [paragraph]);
});
await db().document.update({
  where: { id },
  data: { yjsState: Buffer.from(Y.encodeStateAsUpdate(document)) },
});
await db().$disconnect();
