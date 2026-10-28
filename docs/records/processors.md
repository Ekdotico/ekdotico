# The processors that Ekdotico α 0.1.0 reaches

NFR-DP-03, NFR-IC-13; the processor table of §2.7 (`srs/2-functional-requirements/2.4-and-2.7-restated.md`, "Processors and agreements") at the draft register `docs-decisions@ee3a637`, where Brevo is the email service (register D206) and Scaleway is a processor for the copy of the backups alone (D118). `origin/main` of the Docs (`5ad3a94`) still names Scaleway for email. This record states what the code of this repository sends to each, which `tests/unit/processors.test.ts` holds to the code. The columns that only the owner can fill are marked **owner**.

α 0.1.0 is used by the founding team alone and sends nothing to Praktico. It reaches three of the five processors.

## A. Reached

| Processor    | Role in α 0.1.0                                                                                                                                     | What it receives, as the code stands                                                                                                                                          | Where it processes                                                                                | Transfer mechanism            | Agreement (DPA)                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| DigitalOcean | Hosting of the web application and the collaboration server, managed PostgreSQL, Valkey, and Spaces for the images, all in FRA1                     | Every stored table of storage-match.md section B, the Valkey keys of section D, and the image objects of section C. Nothing leaves it in clear                                | FRA1 (Frankfurt). Confirmation from the DPA: **owner**                                            | None expected: **owner**      | Required; pre-launch blocking. Executed on: **owner**. Filed at: **owner**                      |
| Scaleway     | Object storage for the encrypted copy of the backups, and for nothing else (D118)                                                                   | One file for each copy, sealed on the host to a public key whose private half is offline (`scripts/backup-envelope.ts`). Scaleway cannot read it. The keys name only the time | A region of the EEA, recorded in the run record of procedure 6: **owner**                         | None expected: **owner**      | Required before the first copy is stored; read again for this purpose. Executed on: **owner**   |
| Brevo        | The email of the account and of a document invitation, an offer of ownership and a cleared document (register D206). **Nothing is sent**: see below | Nothing yet. The only sender built writes each message to a file (`src/lib/email/index.ts`), and `EMAIL_TRANSPORT=sink` is the only value `settings.ts` takes                 | Not known. To verify from Brevo's own documentation and from the DPA, not yet read (register Q50) | Not known; not yet read (Q50) | Required; pre-launch blocking. The DPA has not been read. **None of the checks of Q50 is made** |

**Brevo.** Q50 is open: the text of its agreement; where it processes, through which sub-processors and whether within the EEA (NFR-IC-13); how long it keeps its record of recipients and subjects; the standing of its API; whether it offers an idempotency key. Until the owner confirms them no real email is sent, and the code has no client of Brevo (`tests/unit/processors.test.ts` fails if one is added). The sink's files are on the host's disk (storage-match.md section E, owed R27-1); they are not a processor.

**Location (NFR-IC-13).** The build-phases limit says "the email service is in Paris". That was Scaleway's; nothing is known of Brevo's, and the sentence is not repeated (docs/plan/slice-27.md, S27-9).

## B. Not reached in α 0.1.0

| Processor | Why not                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------- |
| Anthropic | The release calls no AI provider (build-phases exclusions). No client in `package.json`, no host in `src` |
| OpenAI    | The same: embeddings belong to the source library, which the release does not build                       |

Both rows of §2.7 stay as they are, "Required; pre-launch blocking", before the release that reaches them. No agreement is owed for α 0.1.0 by this record; what must be on file before test users are admitted is the owner's to resolve (register L3).

## C. Not processors

Better Auth is a library inside the application, with its tables in the application's database; there is no identity processor. Cloudflare and Neon are not processors once Praktico has moved to Frankfurt; the release sends nothing to Praktico. The checker of NFR-RE-03 is given no personal data, so it is not a processor either (build-phases).
