# Ekdotico α 0.1.0: implementation plan

Status: **accepted by the owner on 7 October 2026**, with the answers recorded at the end of section 6. Slice 0 is merged. One point is open: how far "not at the moment" reaches for email, which decides whether slice 3 can deliver an invitation link at all.

Written on 7 October 2026 against Docs commit `f4ec614` (612 requirements, decisions D1 to D121).

## 1. Basis, and what was not read

The cut is 73 functional requirements (16 in part) and 44 non-functional release criteria (18 in part), as listed under "Ekdotico α 0.1.0" on the build-phases page. Both counts were checked against the tables row by row.

Read in full: the α 0.1.0 section of build-phases, with the six test procedures; the introduction of the register and its rows Q8, Q26, Q29, Q33, Q35, P13 to P16, A28, A38, A39, A102 to A104, D83, D84, D110 to D118; the normative text of every functional requirement and release criterion in the cut; §2.4 and §2.7 where the criteria cite them; contract clauses IC-18, IC-23, IC-24, IC-49, IC-50, IC-51; the α sections of data-models, api-design, sequence-diagrams, architecture, and tech-stack.

Not read, and so not relied on: data-models lines 554 to 967 (models outside the cut); contract sections 1 and 5; clause (g) of FR-PR-70 beyond its lead sentence (the build-phases page says it "is met by the port alone"); the Better Auth documentation. **No statement below about what Better Auth can do has been checked against the library**; slice 2 opens with that check.

## 2. Choices the specification leaves to the implementer

Each is internal unless marked. A marked one touches something observable and is repeated in section 6 as a question.

| # | Choice | Proposed | Why |
|---|---|---|---|
| C1 | Package manager | pnpm 10, exact pins, `auto-install-peers=false` | Not named in the SRS; the suite's other repositories use it |
| C2 | Layout | One package. `src/app` (Next.js 16), `src/collab` (the collaboration server, a second entry point), `src/lib` shared, `scripts/` (provisioning, admission command), `prisma/` | A workspace buys nothing for two processes that share one schema and one configuration |
| C3 | TypeScript, ESLint | Latest stable that the Next.js lint preset admits, measured at install; each one held back gets an entry in the decision record log (NFR-IC-04) | In September the suite was capped at TypeScript 6.0.3 and ESLint 9; to be measured again |
| C4 | Unit and integration tests | Vitest, against real local PostgreSQL, Valkey, and an S3-compatible store; no mocks of those three | The security tests have to fail when the rule is broken, which a mock cannot show |
| C5 | End-to-end and accessibility | Playwright on Chromium, Firefox, WebKit, and Edge; `@axe-core/playwright` for the automated check. These are P16 tools: recorded with their versions when first used | NFR-IC-05, NFR-IC-19 |
| C6 | Local services | One compose file: PostgreSQL, Valkey, an S3-compatible store, and a small reverse proxy so that the web application and the collaboration server share one origin, as production must | The session cookie is host-only (NFR-SE-17 (c)) |
| C7 | One origin, two processes | The collaboration server is reached at the path `/collab` on the application's origin, by the proxy | Works under either deployment form of Q8 |
| C8 | Timers | `setInterval` in each process, started once at boot. "Once across two instances" by an atomic claim in SQL (`UPDATE … WHERE claimedAt IS NULL RETURNING`), as NFR-RE-15 describes. No leader election, no lock service | The text asks for idempotent effects and a row marked before hand-over, nothing more |
| C9 | Rate limits and failed-sign-in counters | A small module of our own over Valkey; every limit a setting | NFR-SE-07 forbids instance memory and allows Valkey |
| C10 | Connection count | A per-instance set in Valkey with a short expiry that each instance renews, so a dead instance's connections fall out of the count by themselves | NFR-PE-05 with the kill test of NFR-RE-07 |
| C11 | Two instances storing one document | The Hocuspocus Valkey extension keeps instances merged; each stores the merged state, and a second store of the same state is harmless | NFR-SC-04 |
| C12 | Origin check | Our own, a few lines; no dependency on `@ekdotico/amyntico` | API design allows "one that does the same" |
| C13 | Email | An interface with two senders: Scaleway over HTTPS, and a local sink that writes each message to a file. The sink is the default; the Scaleway sender is selected only by a setting | The brief asks for it; no real email until A52 and A72 are confirmed |
| C14 | Port module | `src/lib/istorico/port.ts` holds IC-49 line for line; `src/lib/istorico/index.ts` is the one module that returns the adapter | IC-49 |
| C15 | Provisioning | `scripts/provision.sql` run with `psql` by an administrator, written to be safe to run again on a fresh database (the restore procedure reuses it) | IC-51 |
| C16 | Identifiers | `Document.id` is UUID version 4 from the database | A23 leaves version 7 open and says an identifier never changes; version 4 needs nothing new |
| C17 | Schema details the page leaves out | Foreign keys with `onDelete: Restrict` unless a requirement deletes the row; an index on `Document(ownerId, deletedAt)`; a partial unique index for "one pending offer a document" | data-models gives none |
| C18 | S3 client, zip, image handling | The AWS S3 client (Apache-2.0); a streaming zip library; see Q13 for image metadata | NFR-IC-12 review in the slice that adds each |
| C19 | Decision record log | `docs/decisions/NNNN-title.md`, the first entry being the Next.js 16 lock that NFR-IC-01 says is transferred there | NFR-IC-01, NFR-IC-04 |
| C20 | Health check | Each answers 200 with an empty body when its process is up, and checks no dependency | "Returns nothing else" (NFR-SE-05) |
| C21 | **Wire format of the admission signature** | See Q9 | Praktico must match it later |
| C22 | **Where the security log is kept** | See Q4 | Stored data |

## 3. The slices

Each row is one pull request that leaves `main` deployable. A slice with security-sensitive code gets an independent review before merge; they are marked **R**. Requirements "in part" are built only for the part the build-phases page states.

### Stage A: walking skeleton

| # | Pull request | What it holds | Functional | Release criteria | Assumed rows |
|---|---|---|---|---|---|
| 0 | `chore: walking skeleton` | `package.json` (Node `>=26 <27`, `.nvmrc`, exact pins, `AGPL-3.0-only`); Next.js 16 shell with `@ekdotico/domico` 0.25.0; TypeScript, lint, format; Vitest and one Playwright smoke test; CI on Node 26 running lint, typecheck, tests, build, a check that no pin has a range, and a licence check; compose file and `README` section on starting local services; `scripts/provision.sql` with a test that asserts the schema, the three roles, each privilege, and the `UTF8` encoding; Prisma with an empty first migration in the `ekdotico` schema; the settings loader, which refuses to start without `FOUNDING_TEAM_EMAILS`; `/api/health` and the collaboration server process with its own health check; the decision record log; release-please moved to the `node` type | None | NFR-IC-01, IC-03, IC-04, IC-08, IC-12, IC-16, IC-17, NFR-SE-05 (c), NFR-RE-03 (the endpoints), NFR-I18-01, NFR-I18-03 (encoding), NFR-PE-08 and NFR-DP-05 (as review rules from here on) | A28, A39, A102 |
| 1 | `feat(istorico): the α subset of the port` | IC-49 verbatim, the no-op adapter, the one module that returns it, and tests that assert the capabilities, both results, and that nothing is stored | FR-PR-67, FR-PR-69, FR-PR-70 (g), FR-EX-34, FR-AU-06 | NFR-IC-15 | A20 |

### Stage B: identity

| # | Pull request | What it holds | Functional | Release criteria | Assumed rows |
|---|---|---|---|---|---|
| 2 **R** | `feat(auth): identity foundation` | **Starts with a check of six library behaviours the specification marks unconfirmed** (section 5). Then: Better Auth at an exact pin, configured as NFR-SE-17 lists; the identity tables; `proxy.ts` with the allowlist of session-less paths and session validation (cookie cache for reads only); the origin check; the rate-limit module; the security log; the email interface with the local sink; the advisory check in CI and daily | FR-AU-01, 02, 04, 05, 07 | NFR-SE-01, SE-02, SE-05 (a), SE-06 (A01, A02, A05, A07, A10), SE-17, SE-19, NFR-IC-09, IC-20, NFR-DP-01 | A102 |
| 3 **R** | `feat(admission): invitations, the command, and sign-up` | The three signed endpoints; the command; the invitation email; the sign-up page; the personal workspace in the same transaction, with the backstop | FR-AU-57, 89, 90, 09, 12, 82, 87 (a), 88 | NFR-SE-05 (b), SE-07 (admission row) | None |
| 4 **R** | `feat(auth): sign-in, sessions, and the Closed α notice` | Sign-in and sign-out with the one statement and uniform timing; both session periods; the failed-sign-in limits without the lock; the wizard and its acknowledgement | FR-AU-81 (without the lock), 84, 55, 56 | NFR-SE-07 (sign-in rows), NFR-SE-02 | None |
| 5 **R** | `feat(auth): password reset and the session list` | Reset by emailed link; change of password; list and end sessions | FR-AU-86, 85, 87 (c, d) | NFR-SE-07 (reset rows), NFR-RE-15 (tokens and sessions row) | None |
| 6 **R** | `feat(auth): two-factor and the founding-team gate` | Enrolment, recovery codes, the second step, turning off; the gate on pages, API routes, and (from slice 10) the handshake | FR-AU-83, 87 (f, g) | NFR-SE-17 (d), NFR-SE-07 (codes row) | A102 |
| 7 **R** | `feat(auth): the lock and its sign-in link` | The 1-hour lock at the twentieth failure; the lock email; the page with one control | FR-AU-81 (the rest), 87 (h) | NFR-SE-05 (a), SE-07 | A104 |
| 8 **R** | `feat(account): name and change of address` | Settings for the name and the address; the confirmation link; the notice to the old address | FR-AU-03, 87 (b, e) | NFR-SE-07 (confirmation row) | A102 |

### Stage C: documents and the editor

| # | Pull request | What it holds | Functional | Release criteria | Assumed rows |
|---|---|---|---|---|---|
| 9 **R** | `feat(documents): create, list, rename` | The document model with its permission set stored whole; the authorisation function every route calls; the mark "Not recorded" with its tooltip; dates in local time | FR-ED-35, 43, 39 (the Owner), FR-AU-13 | NFR-SE-04 (frame), NFR-I18-06 | None |
| 10 **R** | `feat(editor): the collaboration server and the text blocks` | Handshake (origin, session row, role, gate); storing within 2 s and every 10 s and on stop; the sync indicator and its recovery; heading, paragraph, lists, blockquote, table, code block, callout, table of contents, page break, horizontal rule; the marks | FR-ED-01, 02, 03, 04, 06, 07, 09, 15, 16, 18 (reconnection), 22, 23, 24, FR-AU-08 | NFR-SE-03 (handshake), SE-08, NFR-RE-07, NFR-SE-07 (handshake row) | None |
| 11 | `feat(editor): slash palette and shortcuts` | The palette, its filter, the rows for the block types of the cut, the keyboard and Markdown shortcuts | FR-ED-10, 11, 12, 13, 14 | None | None |
| 12 **R** | `feat(documents): delete, restore, and permanent deletion` | The deleted list; restore; the daily timer; the capability-guarded erase call site | FR-ED-36, 40 (c) | NFR-RE-15 (deletion row) | None |

### Stage D: sharing, permissions, notifications

| # | Pull request | What it holds | Functional | Release criteria | Assumed rows |
|---|---|---|---|---|---|
| 13 **R** | `feat(sharing): invitations and the notification list` | Invite, the uniform answer, the email, accept and decline, revoke and resend, expiry, the limit of ten people; the notification list; a Viewer's connection read-only at the protocol | FR-ED-19, 20, 21, 37, 39 (all roles), 42 (invitations) | NFR-SE-07 (invitation row), NFR-RE-15 (invitation email) | None |
| 14 **R** | `feat(collab): presence, the limit of ten connections, two instances` | Named cursors in the collaborator colours; the count across instances; the refusal with its statement and the 30-second retry | FR-ED-17, 18 (the limit) | NFR-PE-05, NFR-SC-04 | None |
| 15 **R** | `feat(sharing): change a role, remove, leave, and ending a connection` | The events on the shared channel; close or read-only in place within 5 s; the 60-second re-check | FR-ED-38, 40 (a, b, d), 41, FR-AU-27 | NFR-SE-03, NFR-RE-15 (re-check row) | None |
| 16 **R** | `feat(permissions): the permission set and its settings` | The table of FR-ED-44; the Owner's changes; the settings screen; one test for every permission and every role | FR-ED-44, 45, 46, 40 (g) | NFR-SE-04 | None |
| 17 **R** | `feat(sharing): transfer of ownership` | Offer, accept, decline, withdraw, expiry; the move to the new Owner's workspace | FR-ED-47, 40 (h), 42 (offers) | NFR-RE-15 (offer rows) | None |
| 18 | `feat(sharing): the reminder and the clearing of addresses` | The one reminder 3 days before expiry; the clearing of an invited address after 30 days | FR-ED-48, 42 (reminders) | NFR-RE-15 (reminder and address rows) | None |

### Stage E: images, export, deletion, clearing

| # | Pull request | What it holds | Functional | Release criteria | Assumed rows |
|---|---|---|---|---|---|
| 19 **R** | `feat(editor): images` | Upload with everything NFR-SE-18 requires; the 5-minute link; the orphan timer | FR-ED-08 | NFR-SE-18, NFR-SE-07 (upload row), NFR-SE-06 (A01, no remote image), NFR-RE-15 (image row) | None |
| 20 | `feat(editor): footnotes` | The marker, the entry, the numbering | FR-ED-05 | None | None |
| 21 **R** | `feat(export): the Markdown draft export` | The streamed zip; the mapping table; the name rule; one export at a time; the Unicode round-trip test | FR-EX-01, 02, 36 | NFR-PE-01 (export row), NFR-SE-07 (export row), NFR-SE-08 (front matter), NFR-I18-03, I18-04 | None |
| 22 **R** | `feat(account): deletion of an account` | The refusal while documents are owned; the steps in order, each retried; step (c) behind `FEEDBACK_INTAKE_ENABLED`, off, with its tests; the tombstone | FR-AU-58 | NFR-DP-06, DP-09, NFR-RE-15 (deletion steps) | None |
| 23 **R** | `feat(account): clearing the documents, and the notice period` | Clear all; the 7 days of notice; read-only for everyone; the notices; cancel | FR-AU-91, FR-ED-40 (i), 42 (clearing notices) | NFR-RE-15 (clearing row) | A103 |
| 24 | `feat(account): transfer of all documents` | The bulk offer and its per-document states | FR-AU-92 | None | None |

### Stage F: the release criteria

| # | Pull request | What it holds | Release criteria |
|---|---|---|---|
| 25 | `test: two instances of each process` | Every timer row shown to take effect once with two web instances and two collaboration instances; every limit of NFR-SE-07 exceeded across two instances | NFR-RE-15, NFR-SE-07, NFR-SC-04 |
| 26 | `test: accessibility and browsers` | The list of pages and dialogs with their states; the automated check in one light and one dark mode; the function list of procedure 4; the suite on four browsers | NFR-IC-19, NFR-IC-05 |
| 27 | `docs: records the release must carry` | The match of each table and storage prefix to a row of §2.7; the processor rows; the secret-rotation procedure; the six procedures as runnable checklists with a place for each record; the reference document as a fixture and the measuring harness; the backup script, tested locally | NFR-DP-02, DP-03, NFR-SE-17 (e), NFR-RE-10, NFR-PE-01 (editor rows), NFR-IC-14, IC-10, IC-13 |

### What cannot be shown from this repository alone

These criteria end in a procedure on the Frankfurt deployment, which is the owner's to provision. The plan delivers the code, the local test, and the checklist; the run itself is not mine to do.

- NFR-PE-01, the two editor rows (procedure 1).
- NFR-RE-03, the checker and the alert (procedure 2).
- NFR-RE-10, both restores (procedure 6).
- NFR-IC-13, the location of every host.
- NFR-SE-06 A04, TLS, and NFR-SE-18, the bucket policy.
- NFR-IC-05, the manual pass at the minimum browser versions, and NFR-IC-19, the keyboard and screen-reader passes: these need a person, not the deployment.

## 4. Nothing unassigned, nothing outside

### The 73 functional requirements

| Requirement | Slice | | Requirement | Slice |
|---|---|---|---|---|
| FR-AU-01, 02, 04, 05, 07 | 2 | | FR-ED-17 | 14 |
| FR-AU-03 | 8 | | FR-ED-18 (part) | 10, 14 |
| FR-AU-06 | 1 | | FR-ED-19, 20 (part), 21, 37 | 13 |
| FR-AU-08 | 10 | | FR-ED-22, 23, 24 | 10 |
| FR-AU-09, 12 (part) | 3 | | FR-ED-35 | 9 |
| FR-AU-13 | 9, 17 | | FR-ED-36 | 12 |
| FR-AU-27 (part) | 15 | | FR-ED-38 | 15 |
| FR-AU-55, 56 | 4 | | FR-ED-39 | 9, 13 |
| FR-AU-57, 89, 90 | 3 | | FR-ED-40 (part) | 12, 15, 16, 17, 23 |
| FR-AU-58 | 22 | | FR-ED-41 | 15 |
| FR-AU-81 | 4, 7 | | FR-ED-42 (part) | 13, 17, 18, 23 |
| FR-AU-82 | 3 | | FR-ED-43 | 9 |
| FR-AU-83 | 6 | | FR-ED-44 (part), 45, 46 | 16 |
| FR-AU-84 | 4 | | FR-ED-47 | 17 |
| FR-AU-85, 86 | 5 | | FR-ED-48 | 18 |
| FR-AU-87 | 3, 5, 6, 7, 8 | | FR-EX-01 (part), 02 (part), 36 | 21 |
| FR-AU-88 | 3 to 8 | | FR-EX-34 | 1 |
| FR-AU-91 | 23 | | FR-PR-67, 69, 70 (part) | 1 |
| FR-AU-92 | 24 | | FR-ED-01 (part), 02, 03, 04, 06, 07 (part), 09 (part) | 10 |
| FR-ED-05 (part) | 20 | | FR-ED-08 | 19 |
| FR-ED-10, 11, 12 (part), 13 (part), 14 (part) | 11 | | FR-ED-15, 16 | 10 |

Count: 28 FR-AU (FR-AU-27 among them), 38 FR-ED, 4 FR-EX, and 3 FR-PR: 73.

### The 44 release criteria

| Criterion | Slice | | Criterion | Slice |
|---|---|---|---|---|
| NFR-SE-01 | 2 | | NFR-DP-01 | 2, 27 |
| NFR-SE-02 | 2, 4 | | NFR-DP-02, DP-03 | 27 |
| NFR-SE-03 | 10, 15 | | NFR-DP-05 | 0 (rule), 2 (allowlist test) |
| NFR-SE-04 | 9, 16 | | NFR-DP-06, DP-09 | 22 |
| NFR-SE-05 | 0, 2, 3, 7 | | NFR-SC-04 | 14, 25 |
| NFR-SE-06 | 2, 19 | | NFR-IC-01, 03, 04, 08, 12 | 0 |
| NFR-SE-07 | 2 to 8, 10, 13, 19, 21, 25 | | NFR-IC-05 | 26 |
| NFR-SE-08 | 10, 21 | | NFR-IC-09 | 2, 10 |
| NFR-SE-17 | 2, 6 | | NFR-IC-10 | 27 |
| NFR-SE-18 | 19 | | NFR-IC-13 | 27 |
| NFR-SE-19 | 2, then each slice that adds a logged event | | NFR-IC-14 | 27 |
| NFR-PE-01 | 21, 27 | | NFR-IC-15 | 1 |
| NFR-PE-05 | 14 | | NFR-IC-16, IC-17 | 0 |
| NFR-PE-08 | 0 (rule) | | NFR-IC-19 | every UI slice, 26 |
| NFR-RE-03 | 0, 27 | | NFR-IC-20 | 2 |
| NFR-RE-07 | 10 | | NFR-I18-01 | 0 |
| NFR-RE-10 | 27 | | NFR-I18-03, I18-04 | 0, 21 |
| NFR-RE-15 | 5, 12, 13, 15, 17, 18, 19, 22, 23, 25 | | NFR-I18-06 | 9, 13, 17 |

Outside the cut and in no slice: the Feedback Widget (FR-AU-59 to 80), comments, the Reviewer role, every export but the draft, the job queue, the `vector` extension, anything in the browser for Istorico, and every Not decided row.

## 5. Better Auth: six things to check before slice 2 is built

The specification itself marks each of these "not confirmed" or "verified when built". Slice 2 begins by trying each against the pinned version. If one fails, I stop on it and report, with the fallback the text gives where it gives one.

1. A session can be created for a user outside the library's own sign-in endpoints, with magic links switched off (A104; the lock link depends on it).
2. The second-factor secret and the recovery codes are encrypted or hashed at rest (NFR-SE-17 (a)).
3. A route can ask for a validation that passes over the cookie cache (D116). Fallback stated: read the session row directly.
4. The 30-day absolute lifetime can be enforced beside the library's own renewal (FR-AU-84).
5. The user table can be extended, a user can be created from an admission invitation while public sign-up is off, and a user row can hold a null address for the tombstone (FR-AU-05, FR-AU-58, FR-AU-90).
6. The host-only cookie reaches the collaboration server on the same origin (NFR-SE-17, FR-AU-08). Alternative stated: a single-use ticket.

## 6. Questions for the register

Each is written as a ready-made row. "Blocks" names the slice that cannot be finished without the answer; every other slice carries on. I have not assigned register identifiers, since those are the Docs' own.

| # | What is open | Recommended answer | Alternatives | Who decides | α 0.1.0 |
|---|---|---|---|---|---|
| Q1 | **A 429 against the uniform answer.** NFR-SE-07 says a request over a limit "receives a 429 response that states when the caller may try again", and that "an automated test shall exceed each limit of the table and receive a 429". Three rows of the same table forbid it: failed sign-ins are "refused, with the statement of FR-AU-81", which must not show that an account is locked; a reset over the limit for an address "receives the same answer as any other"; and five wrong codes abandon the sign-in. The test cannot pass as written | Those three rows are exempt from the 429: over the limit, each gives its own uniform answer and processes nothing, and the test asserts that. Every per-network-address row still answers 429 | (1) 429 on all rows, which tells an attacker that an address is locked. (2) 429 only once the per-address limit is also reached | The owner | Issue: blocks the tests of slices 4, 5, 6 |
| Q2 | **How a notification opens a document invitation.** FR-ED-21 stores the token "only as a hash". FR-ED-42 says the notification links "to its acceptance page", and FR-ED-48 that the reminder email links to the notification list, "from which the signed-in account opens the invitation". The only acceptance routes are keyed by the token, which a stored notification cannot carry | A second way to the same page, keyed by the invitation's identifier, which needs a session and answers only the account that holds the invited address verified. The token link stays for the email | (1) The notification links to a page listing the account's pending invitations. (2) The notification stores the token encrypted under a server key | The owner | Issue: blocks slice 13, and with it 18 |
| Q3 | **Confirming a change of address by opening a link.** FR-AU-03: the change "takes effect only when the user has opened a single-use link". NFR-SE-17 (c): every request that changes state is refused unless its Origin is the application's own; a link opened from an email is a GET without one. The lock link was given a page with one control for this reason; FR-AU-03 was not. And "every other session of the account ends" is undefined where the browser that opens the link holds no session | As the lock link: the page shows the new address and one control, and the change is made by that control. All sessions of the account end except the one in the browser that confirms, if it has one | (1) The GET makes the change, as an exception to the origin check. (2) The link only works in a signed-in browser | The owner | Issue: blocks slice 8 |
| Q4 | **Where the security log is kept.** NFR-SE-19 requires entries kept 30 days and then deleted by a timer, and NFR-DP-02 requires each table and storage prefix matched to a retention row. "What α 0.1.0 migrates" has no model for it, and no page names a table, a file, or a stream | A table in the `ekdotico` schema: time, kind, user identifier, document identifier, and nothing else; added to data-models and matched to its row of §2.7 | (1) The process's standard output, kept by the host, with retention set there; the timer row then has nothing to do. (2) A file on the host | The owner | Issue: blocks slice 2 |
| Q5 | **The network address of a client.** NFR-SE-07 limits by network address and FR-AU-84 stores "the network address it began from". No text says which proxy is trusted or which header carries the address, and the form of the deployment is Q8 | A setting that gives the number of trusted proxies in front of the application, default 0, in which case the address of the connection is used. Set with Q8 | (1) Trust the first address of `X-Forwarded-For` always, which a client can forge. (2) Decide with Q8 and build nothing until then | The owner | Issue: blocks the per-address limits of slices 2 to 7 |
| Q6 | **Wording the requirements ask for and do not give.** The rules of this repository make a displayed word that the Docs do not settle a gap. About twenty statements are required and unworded, among them: the password-rule refusals (FR-AU-82), the two-factor screens, a used or expired reset or confirmation link, the lock-link page and its control, the deletion confirmation, the "neutral statement" of FR-ED-21 and FR-ED-37, the statement when access ends (FR-ED-41), the new-role and changed-permissions statements (FR-ED-40 (b), (g)), the inconsistency message (FR-ED-24), the refusal at an image limit (NFR-SE-18), the draft note in the Markdown (FR-EX-36), and the notifications of an invitation, a reminder, and an offer | I write each under the Expression Guidelines, list every new text in the pull request that adds it, and the owner approves the texts with the pull request. A fixed text quoted in a requirement is never touched | (1) Every text is added to its requirement first. (2) The texts are collected in one file of this repository that the owner signs off once | The owner | Issue: reaches every UI slice from 3 |
| Q7 | **The Reviewer role on the server.** The build-phases page says the role "is not offered". FR-ED-21 and FR-ED-38 still name it among the roles a request may assign, and API design lists it. No text says what the server answers to a request that names it | Refused with a 422. The Reviewer column stays in the stored permission set, as FR-ED-44 says | (1) Accepted by the server and merely absent from the screens. (2) Removed from the stored set as well | The owner | Issue: blocks slices 13, 15 |
| Q8 | **Status codes and the body of an error.** API design says error shapes "are consistent across all routes" and defines none. Unstated in the SRS: the refusals of an image (wrong type, over 20 MB, over 100 MB); an invitation created during a notice period; a document that does not exist against one the caller may not see; an API call by a founding-team account without two-factor; a request by an account in deletion; and the precedence where FR-ED-45 gives both 422 ("whoever asks") and 403 (not the Owner) | One shape, `{ "error": { "code", "message" } }`. 415, 413, 413 for the three image refusals; 409 during a notice period; 404 for both document cases, so that existence is not shown; 403 for the gate; 401 for an account in deletion; authorisation before validation, so 403 | (1) 403 where the document exists and the caller has no role, as FR-ED-39 reads literally. (2) Leave each to its slice | The owner | Issue: first reached in slice 9 |
| Q9 | **The wire format of the admission signature.** FR-AU-89 fixes HMAC-SHA-256 over the time, the method, the path, and the exact body, and the 5 minutes. It gives no header names, no encoding, no canonical string, and no response for any outcome. Praktico will have to match whatever is built | Headers `X-Ekdotico-Timestamp` (seconds) and `X-Ekdotico-Signature` (hex); the signed string is the four parts joined by a line feed; 201 created, 200 repeat of a request identifier, 409 account exists, 401 bad signature or time, 404 unknown invitation. Recorded in this repository and handed to Praktico's specification (Q25) | (1) Follow an existing scheme, such as the HTTP Message Signatures standard. (2) Leave it until Praktico's side is written | The owner | Issue: blocks slice 3 |
| Q10 | **Which password prompts count as failed sign-ins.** FR-AU-58 says a wrong password at the deletion and at a clearing does. Nothing is said for a change of password or address, turning two-factor on or off, or replacing recovery codes; nor whether an attempt refused under the 5-in-15-minutes limit counts toward the 20 of the lock; nor what a signed-in user is answered once locked | Every wrong password at any prompt counts. A refused attempt counts toward nothing. A signed-in user who is locked is answered with the statement of FR-AU-81 at the prompt and stays signed in | (1) Only sign-in, deletion, and clearing count. (2) A lock also ends the account's sessions | The owner | Issue: blocks slices 5 to 8 and 22 |
| Q11 | **Three points of the contract.** (a) IC-50 places the creation extension point "after its own commit", where it "marks the document unrecorded", while `Document.recording` is set once at creation and has no default. (b) IC-49 speaks of two call sites of `erase`; step (b) of FR-AU-58 and a clearing (FR-AU-91) also delete. (c) IC-41 has the application refuse to start where the adapter's contract version differs; IC-18 lists "exactly" what α builds and does not list it | (a) The capability is read before the insert, and the guarded call follows the commit. (b) Three guarded call sites: permanent deletion, the account-deletion step, and a clearing. (c) The check is built; it is three lines and cannot fail with the copy | (1) For (b), one call site, as IC-50 names. (2) For (c), not built until the package is adopted | Istorico's owner with the owner | Issue: (a) blocks slice 9; (b) slices 12, 22, 23 |
| Q12 | **The provisioning script and the `vector` extension.** IC-51 has the script grant the migration role the right to create the extension. IC-23 says α "stores none and does not create it". On a managed cluster a role that does not own the database cannot simply be given that right, and no text says how | The α script grants nothing for the extension; the grant arrives with the first release that stores a vector | (1) The script creates the extension itself, unused. (2) The grant is written and its method on DigitalOcean is worked out now | The owner; Istorico's owner agrees for A39 | Issue: slice 0 is built without the grant and says so |
| Q13 | **Stripping metadata without compressing again.** NFR-SE-18 has "all embedded metadata stripped before storage"; A99 has images "stored as they are and not compressed again". Meeting both means removing metadata at the level of the container for each of four formats. The common library for it re-encodes, and bundles a component under the LGPL, which NFR-IC-12 puts to review | Our own removal for PNG, JPEG, GIF, and WebP, about a hundred lines each, with a test file for every metadata kind, and an independent review | (1) Re-encode with the library, which changes the image bytes and needs the licence review. (2) Refuse an image that carries metadata | The owner | Issue: blocks slice 19 |
| Q14 | **How the 100 MB of a document is counted.** Every stored object, or only the images that still appear in the document; an image taken out stays stored for up to 30 days. And what an undo shows when it brings back an image whose object the timer has deleted | Every stored object counts. An image that reappears before its deletion is kept. After it, the block shows that the image is no longer available | (1) Only images that appear count, which lets a document hold more than 100 MB for 30 days. (2) An image taken out is deleted at once, and undo cannot bring it back | The owner | Issue: blocks slice 19 |
| Q15 | **Details of the draft export.** Unstated: the names of the front-matter keys other than `draft`, and the form of the date; the extensions and content types; a table whose header row is off; the width of a resized image | Keys `title`, `date` (the day, ISO 8601, UTC), `id`, `draft`. `.zip` and `.md` from the same stem. A table without a header row is written with an empty header row. The width is not written | (1) The width as an HTML `img` element. (2) A table without a header as HTML | The owner | Issue: blocks slice 21 |
| Q16 | **Smaller points of the editor.** (a) Whether the four inline Markdown rows of FR-ED-14 (bold, italic, strikethrough, code) are in, since the cut says "the rows for the block types above". (b) Whether a colour freed by a closed connection is reused, and what "order of connection" means across two instances (FR-ED-17). (c) Where footnote entries are shown, and what `/footnote` inserts (FR-ED-05). (d) FR-AU-82's refusal of a password that "contains" the local part of the address has no rule for case or for a very short local part | (a) In; their marks are in FR-ED-02 whole. (b) The lowest free colour, taken from the shared count. (c) At the end of the document; the palette inserts the marker and opens its entry. (d) Without regard to case, and only for a local part of four characters or more | For each, the opposite | The owner | Issue: (a) slice 11, (b) 14, (c) 20, (d) 3 |

### The owner's answers of 7 October 2026

Given on the decisions page and read back from its store. They bind the build from here; each still wants its row in the register, which the owner has asked to be requested in one amendment to the Docs once every question has an answer.

| # | Answer |
|---|---|
| Plan | The plan stands; slice 0 starts |
| Gap reports | A register row, handed to the owner in the conversation |
| Q1 | The three rows are exempt from the 429 and give their uniform answer; per-address rows still answer 429 |
| Q2 | A second way to the acceptance page, keyed by the invitation's identifier, for the signed-in account that holds the invited address |
| Q3 | As the lock link: a page with one control; every session ends except the confirming browser's own |
| Q4 | A table in the `ekdotico` schema: time, kind, user identifier, document identifier |
| Q5 | A setting for the number of trusted proxies, default 0 |
| Q6 | Written under the Expression Guidelines and approved in the pull request that adds each text |
| Q7 | Refused with a 422; the Reviewer column stays in the stored set |
| Q8 | "Check the docs repo, it should define this. If it doesn't go with recommended." Checked at `f4ec614`: API design says only that "error shapes are consistent across all routes", and no page defines one. So the recommended answer stands: one shape `{ "error": { "code", "message" } }`, 415 and 413 for the image refusals, 404 for both document cases, 403 for the gate, authorisation before validation |
| Q9 | **Changed on 8 October 2026.** First left until Praktico's side is written, which held slice 3. The owner's words: the true answer is that Praktico should own this, and the application builds the simple format now, provisionally, recorded where a later developer will see it. It is in `docs/contracts/admission-signature.md` (pull request 6), named in `CLAUDE.md` and the readme, and built in one module. Slice 3 is no longer held |
| Q10 | Every wrong password at any prompt counts; a refused attempt counts toward nothing; a locked signed-in user is given the statement and stays signed in |
| Q11 | The capability is read before the insert; three guarded call sites of `erase`; the start-up check is built |
| Q12 | The α script grants nothing for the `vector` extension |
| Q13 | Our own removal of metadata for the four formats, with a test file for each kind and an independent review |
| Q14 | Every stored object counts toward the 100 MB |
| Q15 | Keys `title`, `date`, `id`, `draft`; plain Markdown; width not written |
| Q16 | All four as recommended |
| Email (review of pull request 2) | **"Not at the moment"** (8 October 2026), read as: the requirements that A52 and A72 block are not built yet, against a sink or otherwise. That is FR-ED-21, the emails of FR-ED-47 and FR-ED-48, and FR-AU-86, FR-AU-87, and FR-AU-89's email. To be confirmed by the owner, since it stops the admission email of slice 3 and with it the only way a person receives an invitation link |

### Rows raised by the review of slice 0

Written for the register in its own columns, and held here until the amendment to the Docs is requested.

| What is open | Where | Recommendation | Alternatives | Who decides | α 0.1.0 |
|---|---|---|---|---|---|
| **The runtime role can change the migration history.** NFR-IC-17 gives `ekdotico_app` "read and write on the application schema", and NFR-IC-16 puts the one migration history inside that schema. So the runtime role may delete or alter rows of `_prisma_migrations` (shown on PostgreSQL 17: `DELETE 1`). A runtime that has been taken over could make the next deployment skip a migration or run one again, under the migration role. **The owner's answer of 7 October 2026: leave it as the text has it, and record it.** | NFR-IC-16, NFR-IC-17; contract IC-23, IC-51; `scripts/provision.sql` in the `ekdotico` repository (Docs commit `f4ec614`) | Left as it is in the α line. The runtime role already may delete every row of the application, so the history adds little to what a takeover reaches, and closing it changes the provisioning from one run before the first deployment to a second run after it | (1) The script revokes the role's privileges on the table where it exists, and is run again after the first deployment; each later run must make the revoke after its grants. (2) The history is moved out of the application schema, which NFR-IC-16 forbids as written | The owner | In the release, as written. Reviewed again before the beta line |
| **Two privileges the provisioning script cannot take away.** A role of the application may still connect to another database of the same cluster, since that is revoked on the other database and not from this one. And `ekdotico_backup`, whose privileges are "select on the application schema, and nothing else", can still create a large object, which is a privilege of the cluster and belongs to no schema | NFR-IC-17; register A28; `scripts/provision.sql`, header | The cluster holds the application's database and no other that a role of the application should reach; where it holds one, connection is revoked on it by hand, and the procedure says so. The large object is accepted and stated in A28 | (1) The script is given the names of the other databases and revokes on each. (2) `lo_creat` is revoked from PUBLIC on the cluster, which needs a superuser and so cannot be done on a managed cluster | The owner | In the release, as written |

## 7. Disagreements found, where the governing text is clear

Reported as the rules ask. In each, I follow the SRS, or the contract at the boundary; none needs a decision, and each wants a correction in the Docs.

1. **data-models, datasource block** declares the `pgvector` extension. IC-23 and the build-phases page say α creates none. I leave the block out.
2. **data-models, "What α 0.1.0 migrates"** carries relations to models the cut does not have (`Workspace.memberships`, `Document.sources`, and others beyond the two the page flags). I leave them out.
3. **data-models, notification kinds** lists three. FR-ED-42 and FR-AU-91 require the three notices of a clearing as well.
4. **data-models, `permissionSet`** "holds one entry for each adjustable cell". FR-ED-44 and FR-ED-45 say the set is stored whole, the Reviewer column and the comment rows included.
5. **data-models, `AdmissionInvitation`** has no time of revocation. FR-AU-89 clears the address 30 days after it. A column is needed.
6. **data-models, `AccountDeletion`**: "`feedbackDoneAt` stays null". FR-AU-58 (c) says the step "is recorded as skipped", and null cannot be told from owed once the switch is on. A column or a value is needed.
7. **data-models, `Session` comment** says every validation reads the row. FR-AU-07 allows the cookie copy for a request that reads.
8. **api-design, cancelling a clearing** asks for the password and a code. FR-AU-58 and FR-AU-91 ask for them at the confirmation only.
9. **api-design, paths without a session** omits the lock-link path, which NFR-SE-05 (a) lists.
10. **api-design and sequence 7, the re-check** omits the notice period of a clearing, which FR-ED-41 requires; sequence 8 ends at the notice where FR-AU-90 puts two-factor enrolment first for a founding account.
11. **NFR-SE-06, A07** says sessions "are checked against the database on every request". NFR-SE-02 allows the cookie copy for reads. The sentence in A07 is the older one.
12. **build-phases** still says `@ekdotico/domico` 0.24.0 in four places. The controls the cut needs arrived in 0.25.0, which is the floor.
13. **build-phases** shows the timers and rate limits "with two collaboration server instances". Most timer rows and the API limit run in the web application; slice 25 runs two of each.
14. **build-phases, the export row of NFR-PE-01** has no procedure among the six. Slice 21 times the export of the reference document in CI.
15. **architecture** has no view of the α processes; the plan's topology is assembled from the other pages. **NFR-IC-01** names Valkey only in the Queue row, which the cut excludes, while three criteria require it.
16. **`CLAUDE.md`, as it stood**, named no identity provider; Q26 and the brief say it named Clerk.

## 8. Outside this repository, and the owner's

- `NODE_AUTH_TOKEN` for GitHub Packages: `npm view` returns 401 on this machine, so installs use the `gh` token exported for the session, as before.
- The `domico` package may have to grant this repository access for Actions before CI can install it. Only the owner can, in the package's settings.
- The Scaleway checks (A52, A72), the DigitalOcean infrastructure and its secrets, the deployment form (Q8), and the six procedures on the deployment.
- Branch protection is not available to a private repository on the current GitHub plan, so "never commit to `main`" is kept by discipline.
