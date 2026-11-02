# The match of every store to a row of §2.7

NFR-DP-02; the build-phases page, "the storage matched to the retention schedule". Every table and column of the `ekdotico` schema, every prefix of object storage, every family of Valkey keys, the directory of the email sink and every timer is matched below to a row of the retention schedule of §2.7 (`srs/2-functional-requirements/2.4-and-2.7-restated.md`, "Retention schedule"). `tests/unit/storage-match.test.ts` reads the Prisma schema, the files that use Valkey and the timers, and `tests/integration/storage-match.test.ts` reads a migrated database; each fails for a store that has no entry here, for an entry whose store is gone, and for an entry that names a row not in section A. Every store has a row: the owner's answer to R27-1 (register D270) gave the last five, which the schedule did not name, rows of their own (workspaces, roles, migrations, export-lock, sink-files), and nothing is owed.

Matched against the Docs at `origin/main` `5ad3a94` (pinned `f4ec614`) and the draft register `docs-decisions@ee3a637`, and the five rows of D270 against `docs-answers@b32541e` (Ekdotico/docs#109, `srs/2-functional-requirements/2.4-and-2.7-restated.md`). The first cell of each row below is in those texts. The code is `origin/main` of this repository at `5a402b3`, with the slice that refuses the sink away from a development machine.

## A. The rows of the retention schedule that are used

| Key             | First cell of the row in §2.7                  | Retention, as §2.7 states it                                                                                                                             |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account         | Account and identity data, including           | Account lifetime; a tombstone while Ekdotico is in Closed α                                                                                              |
| credentials     | Credentials: the hash                          | Account lifetime; deleted with the account                                                                                                               |
| sessions        | Sessions, each with                            | Until the session ends; the row removed within 24 hours                                                                                                  |
| tokens          | Password-reset and address-confirmation tokens | 1 hour; removed within 24 hours of expiry                                                                                                                |
| counters        | Counters of failed sign-ins                    | The period of the limit, at most 24 hours                                                                                                                |
| document        | Document content (Yjs state) — unsealed        | Document lifetime; a clearing deletes it at once, or 7 days after its collaborators are told                                                             |
| deleted         | Deleted documents (                            | 30 days after deletion, then permanent deletion                                                                                                          |
| invitations     | Document invitations, with the invited         | Document lifetime; the address cleared 30 days after the invitation ended; expires after 14 days                                                         |
| notifications   | In-application notifications                   | Until the subject no longer exists or the recipient's account is deleted                                                                                 |
| admission       | The email address of a person the team invites | Cleared 30 days after the invitation is revoked or expires, or when the account is deleted                                                               |
| images          | Document images (                              | Document lifetime; an image out of its document is deleted within 30 days                                                                                |
| offers          | Offers of ownership of a document              | Document lifetime; deleted with the document                                                                                                             |
| deletion-record | The record of an account deletion              | Kept with the tombstone; the identifier and the times of the steps, no personal field                                                                    |
| security-log    | Security logs (                                | 30 days                                                                                                                                                  |
| backups         | Backups of the database                        | The recovery window; the copy outside DigitalOcean 4 weeks, by an expiry rule of its bucket                                                              |
| workspaces      | Workspaces: an identifier, a type              | The retention of the row they belong to, which is the account's; no personal field                                                                       |
| roles           | Who holds which role on a document             | The document's lifetime; deleted with the document, and when the account is deleted (FR-AU-58 (f))                                                       |
| migrations      | The database's record of its migrations        | As long as the database; it belongs to no account and no document, and holds no personal field                                                           |
| export-lock     | The short-lived lock that allows one draft     | Held while an export is under way and released when it ends; expires by itself at twice the idle period (FR-EX-36)                                       |
| sink-files      | The files of the email sink                    | None on a deployment, since the sink is refused anywhere but a developer's own machine (D270); on a developer's machine until the developer deletes them |

## B. Tables and columns of the `ekdotico` schema

Every column of every table is named, in the one row it belongs to; there is no row for "the rest". A column the schema or a migration adds fails the tests until it is named here. "Personal" in a note means the columns hold a personal field of a person.

| Table                | Columns                                                                                                                                     | Row             | Note                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| User                 | name, email, image                                                                                                                          | account         | Personal. Cleared at deletion (FR-AU-58 (e))                                                                                      |
| User                 | id, emailVerified, createdAt, updatedAt, twoFactorEnabled, lockedUntil, closedAlphaNoticeAcknowledgedAt, closedAlphaNoticeVersion, erasedAt | account         | The identifier, the lock, the acknowledgement of the notice and its version, `erasedAt` and the table's own times                 |
| Session              | ipAddress, userAgent                                                                                                                        | sessions        | Personal                                                                                                                          |
| Session              | id, userId, token, expiresAt, createdAt, updatedAt                                                                                          | sessions        | The token is a secret; deleted with the row                                                                                       |
| Account              | password                                                                                                                                    | credentials     | The scrypt hash                                                                                                                   |
| Account              | accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope                                                      | credentials     | The library's columns for OAuth, which stay null (a test asserts it)                                                              |
| Account              | id, userId, providerId, accountId, createdAt, updatedAt                                                                                     | credentials     |                                                                                                                                   |
| Verification         | value                                                                                                                                       | tokens          | May hold a pending new address (personal) and the user of a reset link; deleted with the account (FR-AU-58 (d))                   |
| Verification         | id, identifier, expiresAt, createdAt, updatedAt                                                                                             | tokens          | Also an open second step and the link of a lock, by identifier, for their own short periods                                       |
| TwoFactor            | secret, backupCodes                                                                                                                         | credentials     | Sealed under `AUTH_SECRET` (docs/operations/secret-rotation.md)                                                                   |
| TwoFactor            | id, userId, verified, failedVerificationCount, lockedUntil, createdAt                                                                       | credentials     |                                                                                                                                   |
| SecurityLogEntry     | id, createdAt, kind, userId, documentId                                                                                                     | security-log    | A user identifier and a document identifier and nothing else about a person                                                       |
| AdmissionInvitation  | email                                                                                                                                       | admission       | Personal                                                                                                                          |
| AdmissionInvitation  | id, tokenHash, requestId, state, createdAt, expiresAt, revokedAt, acceptedAt, acceptedById                                                  | admission       | The token only as a hash                                                                                                          |
| Workspace            | id, type, ownerId, createdAt                                                                                                                | workspaces      | An identifier, a type and the owner's identifier. Kept with the tombstone (FR-AU-58)                                              |
| Document             | title, yjsState, permissionSet, clearingAt                                                                                                  | document        | The title and the content are the author's. `clearingAt` is the day a clearing deletes the document                               |
| Document             | deletedAt, deletedById, deletionClaimedAt                                                                                                   | deleted         |                                                                                                                                   |
| Document             | id, workspaceId, ownerId, recording, createdAt, updatedAt                                                                                   | document        |                                                                                                                                   |
| DocumentCollaborator | id, documentId, userId, role, addedAt, roleSince, updatedAt                                                                                 | roles           | Two identifiers and a role. Deleted with the document and when the account is deleted (FR-AU-58 (f))                              |
| DocumentInvitation   | email, titlePseudonym                                                                                                                       | invitations     | Personal: the invited address, and a copy of the sender's display name                                                            |
| DocumentInvitation   | id, documentId, role, invitedById, tokenHash, state, createdAt, expiresAt, respondedAt, acceptedById, emailClaimedAt, reminderClaimedAt     | invitations     | The token only as a hash                                                                                                          |
| Notification         | payload                                                                                                                                     | notifications   | Identifiers; for a notice of a deleted document, its title                                                                        |
| Notification         | id, recipientId, kind, createdAt, readAt                                                                                                    | notifications   |                                                                                                                                   |
| OwnershipOffer       | id, documentId, fromUserId, toUserId, state, createdAt, expiresAt, respondedAt, emailClaimedAt, batchId                                     | offers          | The identifiers of the two users and no address. `batchId` joins the offers of one transfer of all documents (FR-AU-92)           |
| DocumentImage        | id, documentId, objectKey, contentType, byteSize, uploadedById, createdAt, unreferencedAt, deletionClaimedAt                                | images          | The row of an object in storage; `objectKey` names its document                                                                   |
| AccountDeletion      | id, userId, requestedAt, istoricoDoneAt, feedbackDoneAt, feedbackSkippedAt, credentialsDoneAt, rowsDoneAt, completedAt, claimedAt           | deletion-record | The identifier of the user and the times of the steps                                                                             |
| DocumentClearing     | id, userId, scope, documentIds, sharedDocumentIds, cancelledDocumentIds, requestedAt, deleteSharedAt, completedAt, emailsClaimedAt          | deletion-record | An account identifier and document identifiers and no personal field. The row names "and of a clearing of an account's documents" |
| \_prisma_migrations  | id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count                                            | migrations      | The name and checksum of each migration (NFR-IC-16)                                                                               |

## C. Object storage

| Prefix    | Where                                              | Row     | Note                                                                                                                      |
| --------- | -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `images`  | The bucket of the images, DigitalOcean Spaces FRA1 | images  | `images/<document>/<random>`; versioned or copied each day to a second bucket in FRA1, the owner's choice (procedure 6)   |
| `backups` | The bucket of the copies, Scaleway, an EEA region  | backups | `backups/<year>/<month>/<time>-<random>.ekdbak`, sealed; the 4 weeks are a rule of the bucket (docs/operations/backup.md) |

## D. Valkey

The test takes every file under `src` that imports `valkey.ts` (`settings.ts` and `valkey.ts` apart) and requires it here. For each file it also takes every string of the form `name:` followed by an interpolation or a quote, and requires the names to be exactly those in the third column: a new family in a file already listed fails the test until it is named, and given a row.

| File                       | Key families                                                                | Literal prefixes in the file                                                          | Row         | Note                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| src/lib/rate-limit.ts      | `limit:<name>:<digest>`, `limit-logged:<digest>`                            | rate-limit, limit, limit-logged                                                       | counters    | A keyed digest of the address or the secret; expires with its period. `rate-limit:` is the text that is digested, not a key                  |
| src/lib/auth/sign-in.ts    | `sign-in-turn:<digest>`, `sign-in-generation:<digest>`                      | sign-in-turn, sign-in-generation                                                      | counters    | A mutex of a sign-in and the number that clears the counts after a reset; expire within the hour                                             |
| src/lib/auth/two-factor.ts | `enrolment-codes:<id>`, `second-step-codes:<id>`, `sign-in-link-codes:<id>` | totp-used, enrolment-codes, sign-in-link-codes, second-step-codes, second-step-failed | counters    | Wrong codes of one enrolment, one second step, one link. `totp-used:` and `second-step-failed:` are marks kept under `limit-logged:<digest>` |
| src/lib/export/lock.ts     | `export-lock:<user>`                                                        | export-lock                                                                           | export-lock | A user identifier and a random token, for twice the idle period of an export (60 seconds)                                                    |
| src/lib/collab/events.ts   | The channel of the events for the collaboration server                      |                                                                                       | not stored  | A channel keeps no message                                                                                                                   |

## E. Files on a host

| Directory                         | Row        | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_SINK_DIRECTORY` (the sink) | sink-files | A file for each message: an address, and a single-use link. Written with `EMAIL_TRANSPORT=sink` alone; Brevo writes no file (what it keeps is in processors.md, not on a host of ours). The sink is refused anywhere but a developer's own machine (D270): the process does not start with it where the origin is not on localhost (`refuseSinkAwayFromDevelopment`, `src/instrumentation.ts`), so a deployment writes none, and no timer deletes them. On a developer's machine they stay until the developer deletes them |

## F. Timers

The test takes the names from `src/lib/timers.ts`.

| Timer                           | Row             | What it enforces                                                       |
| ------------------------------- | --------------- | ---------------------------------------------------------------------- |
| security-log-deletion           | security-log    | The 30 days                                                            |
| ended-session-removal           | sessions        | The row of an ended session removed within 24 hours                    |
| expired-token-removal           | tokens          | Removed within 24 hours of expiry                                      |
| admission-address-clearing      | admission       | The address cleared 30 days after the invitation is revoked or expires |
| invitation-reminder             | invitations     | Deletes nothing: the one reminder                                      |
| invitation-address-clearing     | invitations     | The address cleared 30 days after the invitation ended                 |
| invitation-notification-removal | notifications   | The notification of an invitation that is no longer open               |
| ownership-offer-expiry          | offers          | An offer expires after 14 days                                         |
| ownership-offer-email           | offers          | Deletes nothing: the email of an offer                                 |
| removed-notification-removal    | notifications   | The notification of a removal, 30 days                                 |
| image-deletion                  | images          | An image out of its document, 30 days                                  |
| account-deletion-steps          | deletion-record | The steps of an account deletion                                       |
| clearing-deletion               | document        | The documents of a clearing, at once or after the notice period        |
| clearing-email                  | deletion-record | Deletes nothing: the notice to the collaborators of a cleared document |
| document-deletion               | deleted         | Permanent deletion 30 days after deletion                              |

## G. Periods that are settings

The test loads the settings with no override and requires every numeric setting to be in G or H, once, with the value written here. G are the periods that §2.7 states. H are the others, with the reason they are not a retention of stored data. A new numeric setting fails the test until it has a row in one of them.

| Setting                       | Value | Row          |
| ----------------------------- | ----- | ------------ |
| securityLogRetentionDays      | 30    | security-log |
| deletedDocumentRetentionDays  | 30    | deleted      |
| imageUnreferencedDays         | 30    | images       |
| documentInvitationDays        | 14    | invitations  |
| documentInvitationAddressDays | 30    | invitations  |
| clearingNoticeDays            | 7     | document     |

## H. Numeric settings that are not a retention

| Setting                 | Value     | Why it is not in §2.7                                                                           |
| ----------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| sessionIdleSeconds      | 604800    | The life of a session (FR-AU-84); §2.7 says "until the session ends"                            |
| sessionRenewSeconds     | 86400     | How often a session is renewed (FR-AU-84)                                                       |
| sessionMaxSeconds       | 2592000   | The longest a session lives (FR-AU-84)                                                          |
| cookieCacheSeconds      | 60        | The cookie cache of NFR-SE-17 (c); a copy in the browser                                        |
| secondStepSeconds       | 600       | How long a second step stays open (FR-AU-83); a key in Valkey, under the counters row           |
| secondStepWrongCodes    | 5         | A count of NFR-SE-07                                                                            |
| signInLockSeconds       | 3600      | The lock of FR-AU-81 and the life of its link                                                   |
| trustedProxyCount       | 1         | A count of proxies                                                                              |
| passwordMinLength       | 8         | A length (FR-AU-82)                                                                             |
| passwordMaxLength       | 32        | A length (FR-AU-82)                                                                             |
| admissionInvitationDays | 30        | The expiry of an admission link (FR-AU-89 (a)); the clearing of its address is 30 days after it |
| invitationReminderDays  | 3         | When the reminder of an invitation comes (FR-ED-48)                                             |
| ownershipOfferDays      | 14        | How long an offer is pending (FR-ED-47); the row is kept with the document                      |
| imageDocumentBytes      | 104857600 | The 100 MB of images a document holds (NFR-SE-18)                                               |
| imageLinkSeconds        | 300       | The life of a link to an image (NFR-SE-18); never stored                                        |
| collabStoreDelayMs      | 2000      | When the collaboration server stores a document (NFR-RE-07)                                     |
| collabStoreMaxMs        | 10000     | The same                                                                                        |
| collabErrorAfterMs      | 30000     | When the editor shows its error state (FR-ED-23)                                                |
| collabRecheckMs         | 60000     | The re-check of connections (FR-ED-41)                                                          |
| exportIdleSeconds       | 30        | The idle period of a draft export (FR-EX-36); the lock lives twice as long                      |
| exportNameMaxChars      | 100       | A length (FR-EX-36)                                                                             |
