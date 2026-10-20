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

## Moving a table by cut and paste in a document that holds 100 tables

**Where the behaviour lives:** `src/app/(app)/documents/[id]/table-bounds.ts` and the `Closed` plugin in `extensions.tsx`.

**What happens.** A document holds 100 tables for a writer: a change of the writer's own that would leave it with more than 100, and more than it had, is refused with "The document has no room for another table. A document holds 100 tables." A writer who cuts a table in a document at or past 100 and pastes it elsewhere is refused at the paste, because the paste raises the count. Undoing the cut restores the table.

**Decided as built** on 13 October 2026 (R58).

**Alternatives considered:**

- A paste that restores the count the document had before the cut is let through.

**Watch for:**

- Writers of long manuscripts who reach 100 tables at all.
- Writers who lose a table by cutting it and then being refused the paste, and whether they find undo.

**What would change the decision.** If a writer loses a table this way, or 100 is met in ordinary work, the paste that restores a table is let through, or the number is raised.

## Two writers who add the 100th row of a table at once (D171)

**Where the behaviour lives:** the collaboration server's rule on the bounds of a table, `src/lib/collab/shape.ts`; the held state of the editor, `src/app/(app)/documents/[id]/editor.tsx`.

**What happens.** A table holds 100 rows. Where two writers each add the 100th row to a table of 99 at the same moment, each browser lets its own row through, since each saw 99. The server takes the first and refuses the second, which would bring the table to 101. The second writer's tab goes read-only with the statement "We cannot apply this change. A table holds 100 rows, 100 cells in a row and 10,000 cells, two levels deep, and this change passes our current limits.", the text kept so that it can be copied before the document is reloaded. The same holds for every other limit of a document that two writers reach at once: the 100th table, the 200th code block, and so on.

**Decided as built** on 18 October 2026: accepted for the α line, to be observed in user testing (D171).

**Alternatives considered:**

- The server takes the row and the browsers mend the table, taking out the last row. This is what was built before the server held the bounds, and it removed another writer's work without a word.

**Watch for:**

- Whether a writer ever meets this in ordinary writing, which needs a table at 99 rows and two writers at its end.
- Whether the writer understands the statement, copies the text, and reloads.
- Whether any text is lost.

**What would change the decision.** If writers meet it in ordinary work, or lose text when they do, the server could take the change and the browser of its writer refuse only what passes, or the tab could reload by itself and keep the text.

## Undoing a deletion in a document already past a limit (D184)

**Where the behaviour lives:** the collaboration server's rules on the limits of a document, `src/lib/collab/shape.ts`; the deletions-only state of the browser, `src/app/(app)/documents/[id]/block-limits.ts`; the held state of the editor, `src/app/(app)/documents/[id]/editor.tsx`.

**What happens.** A document already past a limit (more than 5,000 blocks, more than 100 tables, and so on), stored before the limit or by an earlier release, opens to deletions alone. Where the writer deletes a block and then undoes the deletion, the undo puts the block back, which takes the document further past the limit than it is after the deletion. The browser lets an undo through, as it does every change of the collaboration binding; the server refuses it, and the writer's tab goes read-only with the statement of that limit ("We cannot apply this change. Our current limit per document is 5,000 blocks, and this change passes it.", and the like for each limit), the text kept so that it can be copied before the document is reloaded.

**Decided as built** on 18 October 2026: accepted for the α line, to be observed in user testing.

**Alternatives considered:**

- The server takes an undo that brings back no more than the document held when it was opened. The server cannot tell an undo from any other change, so this would let a document grow back to its stored size by any change.
- The browser refuses the undo itself, in the words of the limit, and keeps the tab editable.

**Watch for:**

- Whether a writer ever opens a document past a limit in α, which only a document stored before the limits can be.
- Whether the writer undoes a deletion there, understands the statement, copies the text, and reloads.
- Whether any text is lost.

**What would change the decision.** If writers meet it and lose text or are confused, the browser refuses the undo itself and keeps the tab editable.

## A hidden title when an invitation is sent again, and the Owner's notice when the Editor is removed

**Where the behaviour lives:** `resendInvitation` in `src/lib/documents/sharing.ts`; `withdrawOffersFor` in `src/lib/documents/ownership.ts`.

**What happens.** (1) "Send again" on an invitation whose title was hidden creates a new invitation that hides the title too, with a new pseudonym. The choice "Hide the title" can be made only when an invitation is created. (2) When the Owner removes an Editor, or changes the Editor's role, while an offer of ownership to that Editor is open, the offer ends and the Owner is told that it ended, although the Owner caused it.

**Decided as built** on 21 October 2026, for the owner's confirmation (D207, D208 do not say).

**Alternatives considered:**

- (1) Sending again shows the title, so that the Owner must choose again; or the sharing page offers a control to change the choice of a pending invitation.
- (2) No notice where the Owner is the one who removed or changed the Editor.

**Watch for:**

- An Owner who sends again and is surprised that the title stays hidden, or that it cannot be changed.
- An Owner who finds the notice of an offer that ended after their own removal of the Editor redundant.

**What would change the decision.** The owner's answer to the register rows that the pull request proposes.
