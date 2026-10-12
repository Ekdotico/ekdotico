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

## What a screen reader says in the empty caption of a table

**Where the behaviour lives:** the prompt "Caption" is set in `src/app/(app)/documents/[id]/extensions.tsx`; `@ekdotico/domico` draws it, and from 0.29.0 gives it empty alternative text.

**What happens.** Before 0.29.0 a screen reader read the prompt "Caption" as if it were the caption's text. From 0.29.0 it is not read where the browser supports the alternative text. An empty caption may then be heard as a blank line, with nothing that says it is the caption of the table above it.

**Decided as built** on 12 October 2026 (R35): the prompt is no longer read as text. No screen reader was run.

**Alternatives considered:**

- The description of the text region says that a table has a caption under it.

**Watch for**, with a screen reader (step 17 of the script in the package's README):

- What is said when the cursor enters an empty caption.
- Whether a writer who cannot see the page finds the caption at all.

**What would change the decision.** If nothing names the empty caption, the description of the text region says so.

## What a screen reader says when the slash palette closes

**Where the behaviour lives:** `src/app/(app)/documents/[id]/slash-palette.tsx`; the text "List closed." is the package's.

**What happens.** "List closed." is said when the list closes without a choice. Nothing is said after a block is chosen.

**Decided** on 12 October 2026 (R43, R44). No screen reader was run: the tests read the text of the status region, not what is spoken.

**Alternatives considered:**

- A sentence that confirms the choice, such as "Heading 1 inserted."

**Watch for**, with a screen reader (step 12 of the script in the package's README):

- Whether "List closed." is spoken after Escape, Tab and the cursor leaving the command, and whether it talks over anything.
- Whether silence after a choice leaves the writer unsure that the block was inserted.

**What would change the decision.** If writers are unsure after a choice, the application confirms it in a status region of its own.
