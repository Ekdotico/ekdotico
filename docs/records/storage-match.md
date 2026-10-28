# The match of every store to a row of §2.7

NFR-DP-02; the build-phases page, "the storage matched to the retention schedule". Every table and column of the `ekdotico` schema, every prefix of object storage, every family of Valkey keys, the directory of the email sink and every timer is matched below to a row of the retention schedule of §2.7 (`srs/2-functional-requirements/2.4-and-2.7-restated.md`, "Retention schedule"). `tests/unit/storage-match.test.ts` reads the Prisma schema, the files that use Valkey and the timers, and `tests/integration/storage-match.test.ts` reads a migrated database; each fails for a store that has no entry here, for an entry whose store is gone, and for an entry that names a row not in section A. A store with no row is entered as `none R27-1` and appears under "Owed", which the owner answers (`docs/plan/slice-27.md`, section 7, row 1).

Matched against the Docs at `origin/main` `5ad3a94` (pinned `f4ec614`) and the draft register `docs-decisions@ee3a637`. The first cell of each row below is in all three texts. The code is `origin/main` of this repository at `fb350f9`.

## A. The rows of the retention schedule that are used

| Key             | First cell of the row in §2.7                  | Retention, as §2.7 states it                                                                     |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| account         | Account and identity data, including           | Account lifetime; a tombstone while Ekdotico is in Closed α                                      |
| credentials     | Credentials: the hash                          | Account lifetime; deleted with the account                                                       |
| sessions        | Sessions, each with                            | Until the session ends; the row removed within 24 hours                                          |
| tokens          | Password-reset and address-confirmation tokens | 1 hour; removed within 24 hours of expiry                                                        |
| counters        | Counters of failed sign-ins                    | The period of the limit, at most 24 hours                                                        |
| document        | Document content (Yjs state) — unsealed        | Document lifetime; a clearing deletes it at once, or 7 days after its collaborators are told     |
| deleted         | Deleted documents (                            | 30 days after deletion, then permanent deletion                                                  |
| invitations     | Document invitations, with the invited         | Document lifetime; the address cleared 30 days after the invitation ended; expires after 14 days |
| notifications   | In-application notifications                   | Until the subject no longer exists or the recipient's account is deleted                         |
| admission       | The email address of a person the team invites | Cleared 30 days after the invitation is revoked or expires, or when the account is deleted       |
| images          | Document images (                              | Document lifetime; an image out of its document is deleted within 30 days                        |
| offers          | Offers of ownership of a document              | Document lifetime; deleted with the document                                                     |
| deletion-record | The record of an account deletion              | Kept with the tombstone; the identifier and the times of the steps, no personal field            |
| security-log    | Security logs (                                | 30 days                                                                                          |
| backups         | Backups of the database                        | The recovery window; the copy outside DigitalOcean 4 weeks, by an expiry rule of its bucket      |

## B. Tables and columns of the `ekdotico` schema

`*` is every column of the table that no other row of the table names. A column is named in at most one row of its table. "Personal" in the last column means the column holds a personal field of a person.

| Table                | Columns                                                                                | Row             | Note                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| User                 | name, email, image                                                                     | account         | Personal. Cleared at deletion (FR-AU-58 (e))                                                                                      |
| User                 | \*                                                                                     | account         | The identifier, the lock, the acknowledgement of the notice and its version, `erasedAt` and the table's own times                 |
| Session              | ipAddress, userAgent                                                                   | sessions        | Personal                                                                                                                          |
| Session              | \*                                                                                     | sessions        | The token is a secret; deleted with the row                                                                                       |
| Account              | password                                                                               | credentials     | The scrypt hash                                                                                                                   |
| Account              | accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope | credentials     | The library's columns for OAuth, which stay null (a test asserts it)                                                              |
| Account              | \*                                                                                     | credentials     |                                                                                                                                   |
| Verification         | value                                                                                  | tokens          | May hold a pending new address (personal) and the user of a reset link; deleted with the account (FR-AU-58 (d))                   |
| Verification         | \*                                                                                     | tokens          | Also an open second step and the link of a lock, by identifier, for their own short periods                                       |
| TwoFactor            | secret, backupCodes                                                                    | credentials     | Sealed under `AUTH_SECRET` (docs/operations/secret-rotation.md)                                                                   |
| TwoFactor            | \*                                                                                     | credentials     |                                                                                                                                   |
| SecurityLogEntry     | \*                                                                                     | security-log    | A user identifier and a document identifier and nothing else about a person                                                       |
| AdmissionInvitation  | email                                                                                  | admission       | Personal                                                                                                                          |
| AdmissionInvitation  | \*                                                                                     | admission       | The token only as a hash                                                                                                          |
| Workspace            | \*                                                                                     | none R27-1      | An identifier, a type and the owner's identifier. Kept with the tombstone (FR-AU-58)                                              |
| Document             | title, yjsState, permissionSet, clearingAt                                             | document        | The title and the content are the author's. `clearingAt` is the day a clearing deletes the document                               |
| Document             | deletedAt, deletedById, deletionClaimedAt                                              | deleted         |                                                                                                                                   |
| Document             | \*                                                                                     | document        |                                                                                                                                   |
| DocumentCollaborator | \*                                                                                     | none R27-1      | Two identifiers and a role. Deleted with the document and when the account is deleted (FR-AU-58 (f))                              |
| DocumentInvitation   | email, titlePseudonym                                                                  | invitations     | Personal: the invited address, and a copy of the sender's display name                                                            |
| DocumentInvitation   | \*                                                                                     | invitations     | The token only as a hash                                                                                                          |
| Notification         | payload                                                                                | notifications   | Identifiers; for a notice of a deleted document, its title                                                                        |
| Notification         | \*                                                                                     | notifications   |                                                                                                                                   |
| OwnershipOffer       | \*                                                                                     | offers          | The identifiers of the two users and no address. `batchId` joins the offers of one transfer of all documents (FR-AU-92)           |
| DocumentImage        | \*                                                                                     | images          | The row of an object in storage; `objectKey` names its document                                                                   |
| AccountDeletion      | \*                                                                                     | deletion-record | The identifier of the user and the times of the steps                                                                             |
| DocumentClearing     | \*                                                                                     | deletion-record | An account identifier and document identifiers and no personal field. The row names "and of a clearing of an account's documents" |
| \_prisma_migrations  | \*                                                                                     | none R27-1      | The name and checksum of each migration (NFR-IC-16)                                                                               |

## C. Object storage

| Prefix    | Where                                              | Row     | Note                                                                                                                      |
| --------- | -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `images`  | The bucket of the images, DigitalOcean Spaces FRA1 | images  | `images/<document>/<random>`; versioned or copied each day to a second bucket in FRA1, the owner's choice (procedure 6)   |
| `backups` | The bucket of the copies, Scaleway, an EEA region  | backups | `backups/<year>/<month>/<time>-<random>.ekdbak`, sealed; the 4 weeks are a rule of the bucket (docs/operations/backup.md) |

## D. Valkey

The test takes every file under `src` that imports `valkey.ts` (`settings.ts` and `valkey.ts` apart) and requires it here.

| File                       | Key families                                                                | Row        | Note                                                                                             |
| -------------------------- | --------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| src/lib/rate-limit.ts      | `limit:<name>:<digest>`, `limit-logged:<digest>`                            | counters   | A keyed digest of the address or the secret; expires with its period                             |
| src/lib/auth/sign-in.ts    | `sign-in-turn:<digest>`, `sign-in-generation:<digest>`                      | counters   | A mutex of a sign-in and the number that clears the counts after a reset; expire within the hour |
| src/lib/auth/two-factor.ts | `enrolment-codes:<id>`, `second-step-codes:<id>`, `sign-in-link-codes:<id>` | counters   | Wrong codes of one enrolment, one second step, one link; the period of the step or of the lock   |
| src/lib/export/lock.ts     | `export-lock:<user>`                                                        | none R27-1 | A user identifier and a random token, for twice the idle period of an export (60 seconds)        |
| src/lib/collab/events.ts   | The channel of the events for the collaboration server                      | not stored | A channel keeps no message                                                                       |

## E. Files on a host

| Directory                         | Row        | Note                                                                                                                                         |
| --------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_SINK_DIRECTORY` (the sink) | none R27-1 | A file for each message: an address, and a single-use link. The only sender there is, so a deployment writes them, and no timer deletes them |

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

The test loads the settings with no override and compares each value with the one written here, which is the one in §2.7.

| Setting                       | Value | Row          |
| ----------------------------- | ----- | ------------ |
| securityLogRetentionDays      | 30    | security-log |
| deletedDocumentRetentionDays  | 30    | deleted      |
| imageUnreferencedDays         | 30    | images       |
| documentInvitationDays        | 14    | invitations  |
| documentInvitationAddressDays | 30    | invitations  |
| clearingNoticeDays            | 7     | document     |

## Owed

R27-1, `docs/plan/slice-27.md` section 7 (row 1): `Workspace`, `DocumentCollaborator`, `_prisma_migrations`, the Valkey lock of the draft export and the files of the email sink have no row in §2.7. Each is matched above to what it sits with, and none is claimed to be matched by the schedule.
