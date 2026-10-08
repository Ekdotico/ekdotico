// Prints a fresh random value for AUTH_SECRET, or, with a file name, writes the
// line into that file where the setting is still empty, without printing it.
//
//   node scripts/dev-secret.mjs              prints one
//   node scripts/dev-secret.mjs .env.local   fills an empty AUTH_SECRET= line
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const secret = randomBytes(32).toString('base64url');
const file = process.argv[2];
if (!file) {
  console.log(secret);
} else {
  const text = readFileSync(file, 'utf8');
  if (!/^AUTH_SECRET=$/m.test(text)) {
    console.log(`${file}: AUTH_SECRET is already set, or the line is absent. Nothing changed.`);
  } else {
    writeFileSync(file, text.replace(/^AUTH_SECRET=$/m, `AUTH_SECRET=${secret}`), { mode: 0o600 });
    console.log(`${file}: AUTH_SECRET set.`);
  }
}
