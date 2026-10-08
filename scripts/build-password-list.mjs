// Makes data/common-passwords.txt (FR-AU-82) from the published list it is
// taken from. Run by hand when the list is replaced or its version moves:
//
//   curl -sSf -o <file> <SOURCE>
//   node scripts/build-password-list.mjs <file>
//
// No password leaves the machine: the list comes in, and nothing goes out.
// The record of the list a person reads is data/common-passwords.md; keep the
// two in step. tests/unit/password-list.test.ts reads the result.
import { readFileSync, writeFileSync } from 'node:fs';

const NAME = 'SecLists, Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt';
const VERSION = '2f19f39928b78e4be8b9a0f0a263baf531e33025';
const SOURCE = `https://raw.githubusercontent.com/danielmiessler/SecLists/${VERSION}/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt`;
// The lengths a password can have as the limits are first set (settings.ts).
// A shorter or a longer entry could never be the password that is checked.
const MIN = 8;
const MAX = 32;
// A control character, or a separator of lines, is no printing character and could break a line.
const NOT_PRINTING = /[\p{Cc}\p{Zl}\p{Zp}]/u;

const kept = new Set();
for (const line of readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
  // The form a password is compared in (password-rules.ts): NFKC, lower case.
  const entry = line.normalize('NFKC').toLowerCase();
  const length = [...entry].length;
  if (length < MIN || length > MAX || NOT_PRINTING.test(entry)) continue;
  kept.add(entry);
}
const entries = [...kept];
// The loader takes the lines that begin `#` at the head of the file for the heading.
if (entries[0].startsWith('#'))
  throw new Error('The first entry begins with #: the loader would pass over it.');

const heading = [
  `# ${NAME}`,
  `# Version: commit ${VERSION} of github.com/danielmiessler/SecLists`,
  `# Source: ${SOURCE}`,
  '# Licence: MIT (SecLists, copyright (c) 2018 Daniel Miessler). The passwords are those of the',
  '# ten million Mark Burnett (xato.net) released to the public domain in 2015. The notices in full,',
  '# and the attribution, are in data/common-passwords.md.',
  `# Filter (scripts/build-password-list.mjs): each line in Unicode NFKC and lower case; kept where`,
  `# it has ${MIN} to ${MAX} code points and no control character; each entry once, in the order of`,
  `# the source, most used first. ${entries.length} entries.`,
  '# One password to a line; compared without regard to case. Every line after this heading is an entry.',
];
writeFileSync('data/common-passwords.txt', [...heading, ...entries, ''].join('\n'));
console.log(`${entries.length} entries written.`);
