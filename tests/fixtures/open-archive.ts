// A process that opens a sealed copy with scripts/backup-envelope.ts, for the test of what an interrupted opening
// leaves behind (tests/unit/backup-envelope.test.ts).
//
//   node tests/fixtures/open-archive.ts <copy> <private key file> <directory>      (the passphrase in KEY_PASSPHRASE)
import { readFileSync } from 'node:fs';
import { unseal } from '../../scripts/backup-envelope.ts';

const [file, keyFile, directory] = process.argv.slice(2);
await unseal(file!, readFileSync(keyFile!, 'utf8'), process.env.KEY_PASSPHRASE, directory!);
console.log('opened');
