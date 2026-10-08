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
