// A stored state that no client could send now, written straight into the
// database of the run, as a document stored before the collaboration server
// held a rule could hold it:
//
// - quotes nested deeper than the server takes (src/lib/collab/state.ts), for
//   the test of what the page does with a document it cannot build;
// - or the state in a file, written by the test (src/lib/collab/shape.ts: a
//   table past a bound, which the server refuses from a client).
//
//   node tests/e2e/stored-state.ts <identifier of a document> <depth>
//   node tests/e2e/stored-state.ts <identifier of a document> --file <path>
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { FRAGMENT_NAME } from '../../src/lib/collab/protocol.ts';
import { db } from '../../src/lib/db.ts';

const [id, depth, path] = process.argv.slice(2);
const usage = 'usage: stored-state.ts <identifier of a document> (<depth> | --file <path>)';
if (!id || !(Number(depth) || (depth === '--file' && path))) throw new Error(usage);
let state: Uint8Array;
if (depth === '--file') state = readFileSync(path!);
else {
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
  state = Y.encodeStateAsUpdate(document);
}
await db().document.update({ where: { id }, data: { yjsState: Buffer.from(state) } });
await db().$disconnect();
