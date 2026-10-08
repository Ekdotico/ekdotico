// The rules of a password (FR-AU-82; register D86), in one function that every
// page which sets a password calls on the server. They follow NIST Special
// Publication 800-63B: length in place of composition, and a check against a
// list of known passwords. Every printing character and the space are
// accepted, so nothing here looks at which characters a password holds.
//
// NFR-SE-17 (a), NFR-SE-19: the password is never logged, never returned, and
// never part of an error. No password, and no part or hash of one, leaves the
// process: the list is a file read here.
import { readFileSync } from 'node:fs';
import { settings } from './settings.ts';

// The owner's answer to Q16 (d) of the plan: a local part shorter than this is
// not looked for, since a password can hardly avoid holding "al" or "jo".
const SHORTEST_LOCAL_PART = 4;

// Text for a person (the owner's answer to Q6 of the plan: approved with the
// pull request). Each says which rule the password did not meet.
const REFUSALS = {
  tooShort: (min: number) => `A password has at least ${min} characters. Choose a longer one.`,
  tooLong: (max: number) => `A password has at most ${max} characters. Choose a shorter one.`,
  holdsAddress:
    'A password cannot contain your email address or the part of it before the @ sign, because that makes it easier to guess. Choose a different one.',
  listed:
    'This password is on a list of commonly used and known-compromised passwords, so it cannot be used. Choose a different one.',
};

let list: ReadonlySet<string> | undefined;

// One password to a line. Read once, at the first check; a file that cannot be
// read throws, so that no password is set unchecked (NFR-SE-06, A10).
function listed(password: string): boolean {
  if (!list) {
    const file = settings().passwordListFile;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (cause) {
      throw new Error('The list of known passwords could not be read.', { cause });
    }
    // The file may open with lines that begin `#`, which say what the list is.
    // After the first other line every line is a password, `#` or not.
    const lines = text.split(/\r?\n/);
    const first = lines.findIndex((line) => !line.startsWith('#'));
    list = new Set(
      lines
        .slice(first < 0 ? lines.length : first)
        .filter((line) => line !== '')
        .map((line) => line.toLowerCase()),
    );
  }
  // Without regard to case: "Password" is as well known as "password".
  return list.has(password.toLowerCase());
}

/**
 * The statement of the first rule `password` does not meet, for the person who
 * chose it, or null where it meets them all. `email` is the address of the
 * account the password is for.
 *
 * A character is one Unicode code point, as NIST SP 800-63B counts.
 */
export function checkPassword(password: string, email: string): string | null {
  const { passwordMinLength, passwordMaxLength } = settings();
  const length = [...password].length;
  if (length < passwordMinLength) return REFUSALS.tooShort(passwordMinLength);
  if (length > passwordMaxLength) return REFUSALS.tooLong(passwordMaxLength);

  // "One that contains the account's email address or its local part", without
  // regard to case (the answer to Q16 (d)).
  const address = email.toLowerCase();
  const at = address.lastIndexOf('@');
  const localPart = at < 0 ? address : address.slice(0, at);
  const lower = password.toLowerCase();
  if (address !== '' && lower.includes(address)) return REFUSALS.holdsAddress;
  if ([...localPart].length >= SHORTEST_LOCAL_PART && lower.includes(localPart)) return REFUSALS.holdsAddress;

  return listed(password) ? REFUSALS.listed : null;
}
