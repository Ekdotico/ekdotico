# Procedure 1: editor performance and page load on the reference document

Criterion: the rows "Editor keystroke to character render" and "Yjs sync propagation to collaborator" of §2.4 (NFR-PE-01, NFR-IC-14), on a reference document of 5,000 words and again on one of 50,000 words (register D296), and the largest contentful paint of a page (NFR-PE-01, register D297). Source: the build-phases page, "How each criterion is tested", as amended by register D295 (four keystrokes a second), D296 (50,000 words) and D297 (page load); one collaboration server instance (D169, D174, D175). Run by a member of the team on the Amsterdam (AMS3) deployment. The record is made with `node scripts/record.ts new editor-performance <release>`.

The reference document is `tests/fixtures/reference-document.json`: 5,000 words in headings and paragraphs, no citation, no LaTeX block, no Mermaid block. The one of 50,000 words is made by the same generator (`tests/fixtures/reference-document.ts`, the same seed), so that the two differ in length alone; `seed --words 50000` writes it. The harness is `scripts/measure-editor.ts` (`scripts/measure/`). Its method and its limits are in section "How the harness measures" below; read them once.

## Before you start

- [ ] The release tested: ____ . The commit: ____ .
- [ ] The tools (register P16, chosen with this test and recorded with their versions): `@playwright/test` driving Chromium, version ____ ; `@hocuspocus/provider`, version ____ ; Node.js ____ . `pnpm exec playwright install chromium` has been run on the laptop.
- [ ] Ten accounts of the deployment exist and have signed in once. A file outside the repository (mode 0600), `cookies.json`, holds an array of ten strings, the `Cookie` header of each account's session, the first being the account that owns the document. The file is deleted at the end of the run.

## The runner: steps 1, 2, 5 to 9, 11 and 12 in one command

`node scripts/measure-editor.ts auto` does those steps on both documents, and makes no `cookies.json` (step 13 is done: the ten `Cookie` headers are held in memory). Steps 3, 4 and 10 stay yours.

1. Send nine admission invitations with `scripts/admission.ts create`, one for each tester's address. The owner's account already exists and must already have two-factor authentication on (it is on the founding team).
2. Make `accounts.json` outside the repository, mode 0600 (`scripts/measure/accounts.example.json` shows it): the owner's email and password, and for each tester an `invitationLink` from its email, or a `password` if the account exists. The runner signs a tester up from the link with a generated password, writes the password into the file in place of the link, and prints neither.
3. Run `pnpm exec playwright install chromium`, then `node scripts/measure-editor.ts auto --origin https://… --accounts /path/to/accounts.json`. It asks on the terminal for the owner's six-digit code, and takes about half an hour.

It writes `result-5k.json` and `result-50k.json` beside `accounts.json`, and prints the figures, the people listed, and the versions of Chromium and Node.js, for the checklist below. It stops at the first failure and names the step. It keeps to the limits of the application and does not work round them: it paces the requests of a person without a session under 20 a minute, a second run within the hour is refused by the 20 invitations an hour (the message says when to try again), and a 50,000-word seed that the server refuses ends the run with the reason. It acknowledges the Closed α notice of the ten accounts, as "Continue" does, since the notice stands in place of the editor until then. The invitations to the two documents are emailed to the nine addresses.

## Steps

The steps 1 to 10 are run on the document of 5,000 words, with a result file of its own (`result-5k.json`); step 11 runs them again on the document of 50,000 words (`result-50k.json`); step 12 measures the page load.

- [ ] 1. Create the reference document in the owner's account of the deployment, from the fixture: `node scripts/measure-editor.ts seed --origin https://… --cookies cookies.json --document <id>` after making an empty document in the application. Its word count (the command prints it): ____ (it must be 5,000).
- [ ] 2. Share the document with the nine other accounts as Editor, from the sharing settings, so that it has ten people. Each has accepted. Number of people listed: ____ .
- [ ] 3. Run the one collaboration server instance of the release. Its own connection count accepts connections (from its log or its health output): ____ . The test with two instances belongs to the release that first runs a second instance (register D169, Q42).
- [ ] 4. Take a mid-range laptop on a stable connection to the Amsterdam (AMS3) deployment. Model ____ ; processor ____ ; memory ____ ; operating system ____ ; browser and version ____ .
- [ ] 5. Open ten connections to the document, one for each account, with the harness: `node scripts/measure-editor.ts run --origin https://… --cookies cookies.json --document <id> --minutes 10 --rate 4 --out result-5k.json`. It opens nine connections of its own and the typing browser, and refuses to go on unless all ten are held. Connections held (from the output): ____ .
- [ ] 6. The harness types at a steady four keystrokes a second, the rate at which the client sends its changes (register D295), for at least ten minutes while the nine others stay open and receive. The rate (`--rate`, characters a second; its default is 4): ____ . The length of the run in minutes: ____ . Keystrokes typed: ____ .
- [ ] 7. The harness measures, for each keystroke, the time from the key event to the frame in which the character is drawn, with the browser's own instrumentation. Keystrokes measured: ____ . Any not found in the page: ____ (it must be 0, or the run is repeated).
- [ ] 8. The harness measures, for each change the typing connection sends, the time until each of the nine others has received it, from one clock (the laptop's). Changes measured: ____ for each receiver.
- [ ] 9. The harness computes the P50 and the P99 of both. Keystroke to render: P50 ____ ms, P99 ____ ms. Propagation to a collaborator: P50 ____ ms, P99 ____ ms.
- [ ] 10. Record the laptop of step 4, the size of the instance ____ , the tools and their versions, the rate, the length of the run and the four figures above; keep `result-5k.json` beside the record (it holds no cookie).
- [ ] 11. Run steps 1 to 10 again on a reference document of 50,000 words (register D296): make a new, empty document, share it with the nine accounts as in step 2, and seed it with `node scripts/measure-editor.ts seed --origin https://… --cookies cookies.json --document <id> --words 50000`; run the harness as in step 5 with `--out result-50k.json`, at the same rate and for the same length. Word count of the first document ____ ; of the second ____ (it must be 50,000). Keystroke to render: P50 ____ ms, P99 ____ ms. Propagation to a collaborator: P50 ____ ms, P99 ____ ms. Keystrokes not found in the page: ____ (it must be 0).
- [ ] 12. Measure the page load (register D297), on the laptop of step 4 and the same connection: `node scripts/measure-editor.ts pageload --origin https://… --cookies cookies.json --document <id> --out result-5k.json`, with the document of 5,000 words. The harness loads the list of documents and the reference document, each as many times as `--loads` says (the specification says "many times" and gives no number; the default is 20, and the number is recorded), in a new browser context for each load, so that the cache is empty, and records the largest contentful paint of every load with the browser's own instrumentation. Loads of each page: ____ . P75 of the list of documents: ____ ms. P75 of the reference document: ____ ms. The figures are added to `result-5k.json` under `pageLoad`.
- [ ] 13. `cookies.json` is deleted.

## Met when

The keystroke time is under 16 ms at P50 and under 100 ms at P99, and the propagation time is under 150 ms at P50 and under 400 ms at P99, over a run of at least ten minutes with ten connections held by the one instance, typed on the laptop recorded in step 4, with the reference document of 5,000 words (steps 1 to 10) and again with the document of 50,000 words (step 11); and the largest contentful paint is under 2.5 s at P75 for each of the two pages of step 12. Beyond 50,000 words no budget is promised.

## Result

Met: ____ (yes or no). Signed: ____ .

## How the harness measures

- The typing browser is Chromium under Playwright, with the cookie of the first account. It types into the editor's last paragraph with the keyboard. A listener on the document records `performance.timeOrigin + event.timeStamp` at each `keydown`. A `MutationObserver` on the editor finds the mutation that holds the character, and the harness then waits for the next animation frame and for the task after it: the time of that task is taken as the end of the frame in which the character is drawn.
- The nine other connections are `@hocuspocus/provider` clients in the harness's own process, with the cookies of the other accounts. Each notes the clock at each update of its document, and attributes the characters that appeared to that moment. Both clocks are the laptop's. The propagation time is counted from the key event, not from the moment the provider sends, so it includes the editor's own handling: if it is within the row, the stricter reading of the step is.
- The nine receivers run on the laptop. They are Node clients and are light, but they share its processor; the laptop's load is part of what is measured, and is why step 4 asks for the machine.
- The page load is the `startTime` of the last `largest-contentful-paint` entry of a page, read through a `PerformanceObserver` in Chromium after the load event and a second's wait. The percentile is the nearest rank (the P75 of 20 loads is the 15th smallest), so it is a time that was measured. A page is under its budget when its P75 is below 2,500 ms. The cookie goes to the browser context and is written nowhere.
- Not measured: the propagation of a change from a collaborator back to the typist, a document of more than 50,000 words, and the page load of any page other than the list of documents and the reference document.
