# Procedure 1: editor performance on the reference document

Criterion: the rows "Editor keystroke to character render" and "Yjs sync propagation to collaborator" of §2.4 (NFR-PE-01, NFR-IC-14). Source: the build-phases page, "How each criterion is tested", at the draft register `docs-decisions@ee3a637` (one collaboration server instance, D169, D174, D175). Run by a member of the team on the Frankfurt deployment. The record is made with `node scripts/record.ts new editor-performance <release>`.

The reference document is `tests/fixtures/reference-document.json`: 5,000 words in headings and paragraphs, no citation, no LaTeX block, no Mermaid block. The harness is `scripts/measure-editor.ts` (`scripts/measure/`). Its method and its limits are in section "How the harness measures" below; read them once.

## Before you start

- [ ] The release tested: ____ . The commit: ____ .
- [ ] The tools (register P16, chosen with this test and recorded with their versions): `@playwright/test` driving Chromium, version ____ ; `@hocuspocus/provider`, version ____ ; Node.js ____ . `pnpm exec playwright install chromium` has been run on the laptop.
- [ ] Ten accounts of the deployment exist and have signed in once. A file outside the repository (mode 0600), `cookies.json`, holds an array of ten strings, the `Cookie` header of each account's session, the first being the account that owns the document. The file is deleted at the end of the run.

## Steps

- [ ] 1. Create the reference document in the owner's account of the deployment, from the fixture: `node scripts/measure-editor.ts seed --origin https://… --cookies cookies.json --document <id>` after making an empty document in the application. Its word count (the command prints it): ____ .
- [ ] 2. Share the document with the nine other accounts as Editor, from the sharing settings, so that it has ten people. Each has accepted. Number of people listed: ____ .
- [ ] 3. Run the one collaboration server instance of the release. Its own connection count accepts connections (from its log or its health output): ____ . The test with two instances belongs to the release that first runs a second instance (register D169, Q42).
- [ ] 4. Take a mid-range laptop on a stable connection to the Frankfurt deployment. Model ____ ; processor ____ ; memory ____ ; operating system ____ ; browser and version ____ .
- [ ] 5. Open ten connections to the document, one for each account, with the harness: `node scripts/measure-editor.ts run --origin https://… --cookies cookies.json --document <id> --minutes 10 --rate 6 --out result.json`. It opens nine connections of its own and the typing browser, and refuses to go on unless all ten are held. Connections held (from the output): ____ .
- [ ] 6. The harness types at a steady rate for at least ten minutes while the nine others stay open and receive. The rate (`--rate`, characters a second): ____ . The length of the run in minutes: ____ . Keystrokes typed: ____ .
- [ ] 7. The harness measures, for each keystroke, the time from the key event to the frame in which the character is drawn, with the browser's own instrumentation. Keystrokes measured: ____ . Any not found in the page: ____ (it must be 0, or the run is repeated).
- [ ] 8. The harness measures, for each change the typing connection sends, the time until each of the nine others has received it, from one clock (the laptop's). Changes measured: ____ for each receiver.
- [ ] 9. The harness computes the P50 and the P99 of both. Keystroke to render: P50 ____ ms, P99 ____ ms. Propagation to a collaborator: P50 ____ ms, P99 ____ ms.
- [ ] 10. Record the laptop of step 4, the size of the instance ____ , the tools and their versions, the rate, the length of the run and the four figures above; keep `result.json` beside the record (it holds no cookie). `cookies.json` is deleted.

## Met when

The keystroke time is under 16 ms at P50 and under 100 ms at P99, and the propagation time is under 150 ms at P50 and under 400 ms at P99, over a run of at least ten minutes with ten connections held by the one instance, typed on the laptop recorded in step 4.

## Result

Met: ____ (yes or no). Signed: ____ .

## How the harness measures

- The typing browser is Chromium under Playwright, with the cookie of the first account. It types into the editor's last paragraph with the keyboard. A listener on the document records `performance.timeOrigin + event.timeStamp` at each `keydown`. A `MutationObserver` on the editor finds the mutation that holds the character, and the harness then waits for the next animation frame and for the task after it: the time of that task is taken as the end of the frame in which the character is drawn.
- The nine other connections are `@hocuspocus/provider` clients in the harness's own process, with the cookies of the other accounts. Each notes the clock at each update of its document, and attributes the characters that appeared to that moment. Both clocks are the laptop's. The propagation time is counted from the key event, not from the moment the provider sends, so it includes the editor's own handling: if it is within the row, the stricter reading of the step is.
- The nine receivers run on the laptop. They are Node clients and are light, but they share its processor; the laptop's load is part of what is measured, and is why step 4 asks for the machine.
- Not measured: the propagation of a change from a collaborator back to the typist, and a document of more than the reference's words.
