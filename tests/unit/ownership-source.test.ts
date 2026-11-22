// FR-ED-38: "The Owner cannot be ... given another role other than by a
// transfer of ownership", and FR-ED-47: ownership changes only when the Editor
// accepts. So the code that writes `Document.ownerId` is two places and no
// more: the creation of a document (./documents.ts) and the acceptance of an
// offer (./ownership.ts). This reads every source file for a write that names
// the column, in the form of the query builder or of raw SQL. It is a
// tripwire for a second mechanism, and no proof that there is none.
import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ALLOWED = ['src/lib/documents/documents.ts', 'src/lib/documents/ownership.ts'];

/** The text of a file without its comments, so that a sentence about the column is not a write. */
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

const files = globSync('src/**/*.{ts,tsx}').filter((file) => !file.startsWith('src/generated/'));

// `document.update({ …, data: { …, ownerId: … } })` and its kin, or `SET … "ownerId"` of raw SQL.
const WRITES = [
  /\bdocument\.(?:update|updateMany|updateManyAndReturn|create|createMany|upsert)\(\s*\{(?:[^{}]|\{[^{}]*\})*?data:\s*\{[^{}]*\bownerId\b/s,
  /\bSET\b[^;`]*"ownerId"/is,
];

const CALL = /(?<!function\s)\binsertDocument\(/;

describe('the writes of Document.ownerId (FR-ED-38, FR-ED-47)', () => {
  it('reads the source', () => {
    expect(files.length).toBeGreaterThan(50);
    for (const file of ALLOWED) expect(files).toContain(file);
  });

  it('are in the creation of a document and the acceptance of an offer, and nowhere else', () => {
    const found = files.filter((file) => WRITES.some((write) => write.test(code(file))));
    expect(found.sort()).toEqual(ALLOWED);
  });

  // `insertDocument` takes any owner and any workspace, so a call of it is a write of the column too:
  // the creation of a document and the Onboarding paper, and nowhere else.
  it('is made through insertDocument by the creation and the Onboarding paper alone', () => {
    const CALLERS = ['src/lib/documents/documents.ts', 'src/lib/documents/onboarding-paper.ts'];
    const found = files.filter((file) => CALL.test(code(file)));
    expect(found.sort()).toEqual(CALLERS);
    expect(CALL.test('await insertDocument(tx, input)')).toBe(true);
    expect(CALL.test('export async function insertDocument(')).toBe(false);
  });

  it('knows a write when it sees one', () => {
    expect(WRITES[0]!.test('db.document.update({ where, data: { title, ownerId: userId } })')).toBe(true);
    expect(WRITES[1]!.test('UPDATE "ekdotico"."Document" SET "ownerId" = ${userId}')).toBe(true);
    expect(WRITES[0]!.test('db.document.findMany({ where: { ownerId: userId } })')).toBe(false);
  });
});
