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

**Decided** on 21 October 2026 (D216, D217): the owner confirmed both (a hidden title stays hidden on "Send again", with a new name; the Owner is told whenever the Editor stops holding the Editor role, whoever caused it, and also when the document is deleted).

**Alternatives considered:**

- (1) Sending again shows the title, so that the Owner must choose again; or the sharing page offers a control to change the choice of a pending invitation.
- (2) No notice where the Owner is the one who removed or changed the Editor.

**Watch for:**

- An Owner who sends again and is surprised that the title stays hidden, or that it cannot be changed.
- An Owner who finds the notice of an offer that ended after their own removal of the Editor redundant.

**What would change the decision.** The owner's answer to Q55 to Q58.

## Reaching the formatting toolbar from the keyboard on a Mac (ux-toolbar-keys)

**Where the behaviour lives:** `src/app/(app)/documents/[id]/editor.tsx` (the sentence that tells of the key) and the toolbar's key handling in `extensions.tsx`.

**What happens.** Alt+F10 is the only key that moves from the text to the formatting toolbar and to the controls of a block. On an Apple laptop F10 is the Mute key unless Fn is held, and Option+F10 may be taken by the system.

**Decided** by the owner (ux-toolbar-keys, "Leave Alt+F10 as the only key"). Not run on a Mac with a screen reader.

**Alternatives considered:**

- A second chord, proposed as Alt+Shift+T, checked first against the browsers' own shortcuts.

**Watch for**, with a tester on a Mac who uses the keyboard:

- Whether they find the toolbar at all, and what they press.
- Whether the sentence in the description of the text region is read and understood.

**What would change the decision.** If a Mac tester has no keyboard route to formatting, add the second chord.

## A notification count that is not announced (ux-unread-count)

**Where the behaviour lives:** the header link Notifications and its "N unread" badge.

**What happens.** The number changes when a notification arrives or is read, and a screen reader is not told.

**Decided** by the owner (ux-unread-count, "Leave it: no announcement"). No screen reader was run.

**Alternatives considered:**

- A status region that says "2 unread notifications" at each change (new words).

**Watch for**, with a screen reader user:

- Whether they learn of a new notification only by visiting the page, and whether that costs them an invitation or an offer.

**What would change the decision.** If a tester misses a notification that mattered, announce it, with words the owner approves.

## Forms at the left on a tablet, and three left edges on a phone (ui-forms-tablet, ui-header-edges-phone)

**Where the behaviour lives:** the account settings pages at tablet width; the header of a document on a phone.

**What happens.** At tablet width the settings forms sit against the left edge while sign-in and the lists are centred. On a phone the header of a document starts its rows at three different left edges ("Not recorded", "In sync", and the text of "Export as Markdown").

**Decided** by the owner (ui-forms-tablet, 23 November 2026, "Leave at left"; ui-header-edges-phone, "Leave it as it is").

**Alternatives considered:**

- Centre the settings forms, after the same page is shown at 1280 before and after.
- Align the quiet button's text with the edge on the header too (the edge option for quiet buttons is ordered from Domico; this header case was left out).

**Watch for**, on a tablet and on a phone:

- Whether a tester remarks that settings look different from sign-in, or that the header looks ragged.

**What would change the decision.** More than one tester who says it looks unfinished.

## The selection toolbar below the first line (ui-toolbar-first-line)

**Where the behaviour lives:** the placement of the formatting toolbar, in the application.

**What happens.** When the selection is on the first line, the toolbar appears below it, where there is no room above. It can cover the second line of text while it is open.

**Decided** by the owner on 23 November 2026: "Below the selection".

**Alternatives considered:**

- The page keeps room above the text at all times.
- Leave it as it was, covering "Choose an image" and the upload line.

**Watch for:**

- A writer who selects the first line and then cannot see the second line they meant to select next.
- A writer who is surprised that the toolbar is in two places.

**What would change the decision.** If the covered second line gets in the way, keep room above the text.

## A heading one level lower than its label (ux-heading-levels)

**Where the behaviour lives:** `src/app/(app)/documents/[id]/heading-levels.ts`; Domico's editor styles by `data-level`.

**What happens.** The labels in the Insert list say "Heading 1" to "Heading 3", and the page draws them as levels 2 to 4 under the one level-one heading, the title. Looks are unchanged. A copy puts the stored level on the clipboard.

**Decided** by the owner (ux-heading-levels, "Draw the text's headings one level lower, keep the labels"; ux-headings-domico, 24 November 2026). Built in pull request 170, not yet seen with a screen reader.

**Alternatives considered:**

- Labels that match the drawn levels (new words).

**Watch for**, with a screen reader user who lists the headings:

- Whether the outline reads as one tree, and whether "Heading 1" in the menu and level 2 in the list puzzle them.

**What would change the decision.** If the difference confuses, rename the labels, with words the owner approves.

## A title that holds Greek letters while it is edited (ux-title-greek)

**Where the behaviour lives:** Domico's editable title, used in `src/app/(app)/documents/[id]/document-title.tsx`.

**What happens.** While a title that holds a Greek letter is edited, the whole field is set in the sans face; once editing ends it looks as before, with the Greek letters in the sans and the Latin letters in the serif. A mixed title therefore changes its look when it is edited.

**Decided** by the owner (ux-title-greek, "While editing, set the whole title in the sans face if it contains Greek"). Not seen in forced colours, nor with a screen reader.

**Watch for:**

- A writer who types a Greek word into a title and is startled when the whole title changes face.
- Whether Enter and Escape are found, and whether a refused title (too long) is understood.

**What would change the decision.** If the change of face is jarring, set mixed titles in the serif and accept the fallback face for Greek.

## Pasting a picture (ux-paste-picture)

**Where the behaviour lives:** the image upload in `src/app/(app)/documents/[id]/images.tsx`.

**What happens.** A picture on the clipboard is accepted as an upload, with the same formats, limit and words as the picker and drag-and-drop.

**Decided** by the owner (ux-paste-picture, "Accept pasted pictures, with the same limits and words as the picker"; the margin note on FR-ED-08 approved).

**Watch for:**

- A tester who pastes a screenshot and sees a refusal they do not understand (a large file, a format).
- A tester who pastes by accident and gets an upload they did not want.

**What would change the decision.** If accidental uploads are common, ask first.
