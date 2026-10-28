# Procedure 4: accessibility

Criterion: the authoring application meets WCAG 2.2 at Level AA, shown by an automated check of every page and dialog, by every function completed with the keyboard alone, and by one pass with a screen reader (NFR-IC-19). Source: the build-phases page, "How each criterion is tested". The record is made with `node scripts/record.ts new accessibility <release>`. The list of pages and dialogs (step 1) and the list of functions (step 4) are written by slice 26 and kept where it keeps them; this record names the files and does not repeat them.

## Before you start

- [ ] The release tested: ____ . The commit: ____ .
- [ ] The tools (register P16; chosen by slice 26 with its test): the automated checker ____ , version ____ ; the screen reader ____ , version ____ ; the desktop browser ____ , version ____ .

## Steps

- [ ] 1. The list of every page and every dialog of the release, with the states in which each shows different content (empty, filled, and showing a fault), is kept in the repository. Its path: ____ . A page that is not on it has not been tested.
- [ ] 2. Run the automated checker on each entry of the list, in one light and one dark mode. Results recorded at: ____ .
- [ ] 3. For each failure the checker reports, record the page, the element and the WCAG success criterion, and correct it or record why it is not a failure. Failures found: ____ . Open at the end: ____ .
- [ ] 4. The list of functions to test, written from the functional requirements of α 0.1.0 (every function a user carries out, none left off because it is rare), is kept beside the list of step 1. Its path: ____ . It holds at least: accept an admission invitation and set a password; sign in, with the second step where it is on; sign in by the link of a lock email; ask for and complete a password reset; read and acknowledge the Closed α notice; turn two-factor authentication on, and replace the recovery codes; change the name, the password and the address; list the sessions and end one; create, rename, delete and restore a document; insert each block type from the slash palette; upload an image and give it alt text; invite a collaborator, accept a document invitation, change a role and remove a collaborator; open the notification list and follow a notification; change a cell of the permission settings and return the set to its defaults; offer ownership and accept an offer; take a draft export; open the deletion screen, clear the documents and cancel a clearing; and sign out.
- [ ] 5. Put the pointer aside. With the keyboard alone, complete every function of the list. For each, whether focus was always visible, moved in a sensible order, entered and left each dialog as expected, and was never trapped. Recorded at: ____ .
- [ ] 6. On one desktop browser, with the screen reader, complete the same list once. For each, what is announced for the title of each dialog, for each control without visible text, for each fault and for each confirmation. Recorded at: ____ .
- [ ] 7. Open the sign-in pages at a width of 320 CSS pixels, and at 400 per cent zoom. Each is usable without scrolling in two directions (FR-AU-88): ____ .
- [ ] 8. Record the checker and its version, the screen reader, the browser, and every failure found, each with the success criterion it fails: ____ .

## Met when

The automated check reports no WCAG 2.2 Level A or Level AA failure on any entry of the list; every function of the list of step 4 is completed by keyboard alone; the same functions are completed once with a screen reader on one desktop browser; and the sign-in pages are usable at a width of 320 CSS pixels and at 400 per cent zoom without scrolling in two directions. A failure that is found is recorded with its success criterion, and the criterion is not met while one is open.

## Result

Met: ____ (yes or no). Signed: ____ .
