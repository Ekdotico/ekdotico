// Prints a fresh random value for a secret, or, with a file name, fills the
// secrets of that file that are still empty, without printing them.
//
//   node scripts/dev-secret.mjs              prints one
//   node scripts/dev-secret.mjs .env.local   fills the empty AUTH_SECRET= and ADMISSION_SECRET= lines
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const secret = randomBytes(32).toString('base64url');
const file = process.argv[2];
if (!file) {
  console.log(secret);
} else {
  const text = readFileSync(file, 'utf8');
  // Each empty secret gets a value of its own (NFR-SE-17 (e)).
  const filled = text.replace(/^(AUTH_SECRET|ADMISSION_SECRET)=$/gm, (_, name) => {
    console.log(`${file}: ${name} set.`);
    return `${name}=${randomBytes(32).toString('base64url')}`;
  });
  if (filled === text) console.log(`${file}: no empty secret. Nothing changed.`);
  else writeFileSync(file, filled, { mode: 0o600 });
}
