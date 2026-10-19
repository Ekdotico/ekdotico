// Gives the Editor role the named permissions on a document, in the database of
// the run, as the Owner does by the settings screen (FR-ED-45), without driving
// that screen (tests/e2e/permissions.spec.ts drives it). It publishes nothing.
// Only a cell that FR-ED-44 lets the Owner change may be given.
//
//   node tests/e2e/set-permissions.ts <document> <permission,permission,…>
import { db } from '../../src/lib/db.ts';
import { PERMISSIONS, type Permission, type PermissionSet } from '../../src/lib/documents/permissions.ts';

const [documentId, list] = process.argv.slice(2);
const names = (list ?? '').split(',').filter(Boolean) as Permission[];
if (!documentId || names.length === 0) {
  throw new Error('usage: set-permissions.ts <document> <permission,permission,…>');
}
for (const name of names) {
  const cell = PERMISSIONS[name]?.editor;
  if (cell !== 'on' && cell !== 'off') throw new Error(`${name} is not a cell the Owner may change`);
}
const document = await db().document.findUniqueOrThrow({
  where: { id: documentId },
  select: { permissionSet: true },
});
const set = document.permissionSet as unknown as PermissionSet;
for (const name of names) set[name].editor = true;
await db().document.update({ where: { id: documentId }, data: { permissionSet: set } });
await db().$disconnect();
