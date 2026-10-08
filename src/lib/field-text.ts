// The one rule of a short text a person types into a field: the name of an
// account (FR-AU-90) and the title of a document (FR-ED-35; the owner's
// decision of 8 October 2026, which amends NFR-SE-08 for it).

/**
 * What was typed without the white space at its two ends, and how many
 * characters that is, a character being one Unicode code point. Nothing
 * between the ends is touched.
 */
export function fieldText(value: string): { text: string; characters: number } {
  const text = value.trim();
  return { text, characters: [...text].length };
}

// Text for a person (the owner's answer to Q6 of the plan).
export const NAME_REFUSAL = 'A name has 1 to 100 characters. Enter a name of that length.';

/**
 * FR-AU-90: "a name, of 1 to 100 characters", as it is stored, or null where
 * what was given is none. The one rule of a name, at sign-up and at its change
 * in the account settings. A control character is no character of a name, and
 * PostgreSQL cannot store the first of them.
 */
export function acceptedName(value: unknown): string | null {
  const { text, characters } = fieldText(typeof value === 'string' ? value : '');
  return characters < 1 || characters > 100 || /[\u0000-\u001f\u007f]/.test(text) ? null : text;
}

// What an address must look like. The requirements say "an email address" and
// no more; this refuses what could not be one, and anything that could break a
// header of a message.
const ADDRESS = /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/;

/**
 * An email address as it is stored, in lower case (FR-AU-02), or null where
 * what was given could not be one or is longer than an address can be (254
 * characters). The one rule of an address, for an admission invitation
 * (FR-AU-89) and for the change of an account's address (FR-AU-03).
 */
export function acceptedAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.toLowerCase();
  return email.length > 254 || !ADDRESS.test(email) ? null : email;
}
