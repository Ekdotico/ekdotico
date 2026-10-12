# Points to observe in user testing

This file lists points that the owner decided provisionally and wants to see with test users before the beta. Each entry says what was decided, when, and why it is open; what to watch for; and what would change the decision.

Add an entry whenever the owner decides something provisionally. When a point has been observed and settled, say so under its entry, with the date and the outcome, and leave the entry where it is.

## A slash typed in front of an existing word (R33)

**Where the behaviour lives:** `src/app/(app)/documents/[id]/slash-palette.tsx`.

**What happens.** A slash typed directly in front of an existing word makes the whole word the command. Typing `/` before "code" opens the list filtered to "code", and Enter replaces the slash and the word with the block.

**Decided as built** on 12 October 2026 (R33).

**Alternatives considered:**

- Only what is typed after the slash counts, so the word after the cursor stays out of the filter.
- The list does not open when a word follows the slash.

**Watch for:**

- Writers who wanted a literal slash.
- Writers surprised that their word was replaced.
- Whether Escape is found.

**What would change the decision.** If more than the odd writer loses a word, or cannot get a literal slash without knowing about Escape, choose one of the alternatives.
