# The feedback intake: wire contract

> **PROVISIONAL. Praktico owns the intake's side of this contract.**
>
> The Feedback Widget (FR-AU-59 to FR-AU-80) sends feedback to the feedback intake, a section of Praktico. Praktico's specification does not yet contain the section (register Q25). So that the application's client and Praktico's two routes can be written and tested in parallel, this page states what the specification fixes, what the owner decided on 21 November 2026, and, for the rest, a provisional form. **When Praktico's specification states a format, that statement replaces the provisional parts of this page**, and the application changes to match it.
>
> The signed form is the admission channel's (`docs/contracts/admission-signature.md`), shared, as the owner decided. That form is itself provisional and Praktico's to own; this page does not declare it final.
>
> Draft, updated for the owner's answers of 21 November 2026 on the paths and the one-time value. Read against the `docs` repository at commit `765c6d9` and its draft pull request 139, which records the four answers below as margin notes. No code accompanies this page: the stub and the client come with the application's slice.

## What the owner decided, 21 November 2026

| Question          | Answer                                                                                                                                                                                                                                                                                  | Where it shows on this page                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| fw-hosting        | Build, then move. The intake is built on Cloudflare Workers now and only the founding team uses it until Praktico has moved to Frankfurt; D78 stands as the destination                                                                                                                 | Not a wire matter; the paths below are the same on either host                       |
| fw-switch-scope   | `FEEDBACK_INTAKE_ENABLED` is one switch: it shows the widget, opens the sending route, and turns on deletion step (c)                                                                                                                                                                   | "Browser to application", "Deletion"                                                 |
| fw-signature      | The signature covers a one-time value, the method, the path, the time, and the body, in one form shared with the admission channel. This replaces "time and body" in FR-AU-75                                                                                                           | "The signed form"                                                                    |
| fw-retry-id       | When a send fails, the failure answer returns the server-issued submission identifier; the browser sends it back on the retry; Praktico matches on identifier and account together. FR-AU-69 allows this one further field; FR-AU-68 (f), FR-AU-76, and FR-AU-77 stay true              | "Browser to application", "The retry"                                                |
| fw-intake-path    | Praktico's two routes are `POST /api/feedback/intake` and `POST /api/feedback/pseudonymise`, under the tool's base path, which is `/praktico`. The signed path is therefore `/praktico/api/feedback/intake` and `/praktico/api/feedback/pseudonymise`, on the host `internal.ekdoti.co` | "The three requests", "The signed form", the worked examples                         |
| fw-nonce          | Praktico keeps each one-time value for five minutes and refuses a repeat. What removes an expired value is still open (fw-nonce-removal)                                                                                                                                                | "Verification at Praktico", step 4                                                   |
| fw-statuses       | The three statuses a submission takes in Praktico are "New", "Read", and "Closed", and a new submission is "New". The status is set by the team in Praktico and is never sent by the application                                                                                        | Not on the wire                                                                      |
| fw-privacy-link   | The application's privacy notice is written in this engagement, its text goes to the owner for approval, and the widget ships with it. The address of the page is not yet decided                                                                                                       | Not on the wire                                                                      |
| fw-count-unit     | The 4,000 characters of the message are counted in Unicode code points, and a message that carries an invisible control character is refused                                                                                                                                            | The `message` field, "The refused characters", the two `forbidden_character` answers |
| fw-signed-posture | Praktico's two signed routes have a route kind of their own, "signed"                                                                                                                                                                                                                   | Nothing on this page depends on it                                                   |
| fw-notice-version | When the sentence on feedback joins the Closed α notice, the version of the notice is raised to 2, so that every account sees it once more                                                                                                                                              | Not on the wire                                                                      |

## What is still open

Each of these is the owner's, and none is settled here. Where this page touches one it says "open, awaits the owner" and names the question.

| Question         | What it leaves open                                                                                                                                                                                                | Where it touches this page                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| fw-limit-count   | Whether a send that fails counts against the 5 in 10 minutes and the 30 in 24 hours of FR-AU-78                                                                                                                    | "Browser to application", step 4                                                                              |
| fw-strings       | Every text a reader sees, the `message` of each error body returned to the browser included                                                                                                                        | The error bodies                                                                                              |
| fw-retention     | When feedback is deleted and by what                                                                                                                                                                               | Not on the wire; Praktico's table only                                                                        |
| fw-team-access   | Who may see the team's list in Praktico                                                                                                                                                                            | Not on the wire                                                                                               |
| fw-retry-edited  | The retry rule below keeps the first message the intake accepted. If the user edits the text after a failed send and the first attempt had in fact reached the intake, the edit is dropped. Open, awaits the owner | "The retry"                                                                                                   |
| fw-nonce-removal | What removes a one-time value from Praktico once it has expired                                                                                                                                                    | Not on the wire; Praktico's table of values only                                                              |
| fw-intake-limit  | What limit Praktico applies to its two signed routes, and what it is keyed by                                                                                                                                      | Not on the wire; any answer a limit causes is Praktico's to state, and the application treats it as a failure |

One further point is Praktico's to state in its own specification, and this page does not choose it: any limit Praktico applies to the intake (FR-AU-59: a signed route that carries no session of the team; fw-intake-limit).

## What the specification fixes

- Browser to application: `POST /api/feedback`, to the application's own origin only. A signed-in session of an account that has acknowledged the Closed α notice is required. The limit of FR-AU-78 is applied, and the body validated, before anything else is done (FR-AU-74).
- The application's server delivers each accepted submission to the intake as one HTTPS request, with a secret held only in the server environment of the application and of Praktico. It is not the admission secret and is never sent to a browser (FR-AU-75, NFR-SE-17 (e)).
- The intake accepts a request only where the signature verifies and the signed time is within 5 minutes of its own. A submission whose identifier it already holds is acknowledged as accepted and not stored again. An acknowledgement of acceptance is the only answer the application treats as success (FR-AU-75).
- No answer within 10 seconds, or any answer other than acceptance, is a failure: the user is told, keeps the kind and the message in the open widget, and nothing is queued (FR-AU-77).
- The application keeps no copy of a submission. It keeps the message for the length of the request and logs only the submission identifier and the outcome (FR-AU-76).
- The body carries the kind, the message, and the route, the application version, the browser, the viewport, the account identifier, and the identifier and time of FR-AU-68 (f), and nothing else (FR-AU-75, API design).
- Account deletion step (c): a signed instruction to set the account identifier of every submission that carries it to null, acknowledged with the number changed, and succeeding where there are none; repeated until acknowledged (FR-AU-79).
- Rate limit: 5 in any 10 minutes and 30 in any 24 hours for each account, both settings; a submission over either receives `429` (FR-AU-78, NFR-SE-07).

## The three requests

| Request                                    | Caller                   | Receiver        | Signed                           |
| ------------------------------------------ | ------------------------ | --------------- | -------------------------------- |
| `POST /api/feedback`                       | The browser              | The application | No: the session authenticates it |
| `POST /praktico/api/feedback/intake`       | The application's server | Praktico        | Yes                              |
| `POST /praktico/api/feedback/pseudonymise` | The application's server | Praktico        | Yes                              |

Both paths are under the tool's base path, `/praktico`, on the host `internal.ekdoti.co` (fw-intake-path). The path that is signed is the path as Praktico receives it, in full, base path included: `/praktico/api/feedback/intake` and `/praktico/api/feedback/pseudonymise`, with no query string and no trailing slash.

## The signed form

It is the form of `docs/contracts/admission-signature.md`, with the feedback secret in place of the admission secret and the paths of this page. Nothing below differs from it except where a line says so. If the admission page changes, this form changes with it, since the owner chose one shared form.

### The secret

The feedback secret is held only in the server environment of the application and of Praktico, differs for each environment, and is never the admission secret or any other secret (NFR-SE-17 (e)). Its setting name, and its length and character set, are the application's slice to fix and are not wire matters; the application's rule for the admission secret (at least 43 characters of `[A-Za-z0-9_-]`, 256 bits from a cryptographically secure source) is the one to follow.

### The three headers

Each occurs exactly once on a signed request.

| Header                 | Value                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Ekdotico-Timestamp` | The request time in whole seconds since the Unix epoch: exactly ten decimal digits, `^[1-9][0-9]{9}$`                                                                |
| `X-Ekdotico-Nonce`     | The one-time value: 32 to 64 lower-case hexadecimal digits, `^[0-9a-f]{32,64}$`, made for this request from a cryptographic random source and never used for another |
| `X-Ekdotico-Signature` | Exactly 64 lower-case hexadecimal digits, `^[0-9a-f]{64}$`; upper case is rejected, not folded                                                                       |

### The signed message

The UTF-8 bytes of `<timestamp>\n<nonce>\n<METHOD>\n<path>\n`, followed by the bytes of the request body exactly as sent. `METHOD` is `POST` for both routes. The signature is `HMAC-SHA-256(key, message)` written as 64 lower-case hexadecimal digits, with the key the secret as set, as UTF-8 bytes, never decoded and never trimmed. The caller signs the bytes it sends and the receiver verifies the bytes it received; a body parsed and written out again does not verify.

### Verification at Praktico, in order

1. Each header occurs once and matches its pattern, the target is exactly the path of the route with no query string, no trailing slash and no percent-encoding, the method is `POST`, and the body is at most 65,536 bytes; or the request is rejected.
2. The absolute difference between Praktico's clock, in whole seconds, and the timestamp is at most 300; or the request is rejected.
3. The signature is recomputed and compared, as 32 bytes, in constant time; or the request is rejected.
4. The nonce is recorded by one atomic insert under a unique constraint, and kept until the signed time is more than 5 minutes in the past; a request whose nonce is already held is rejected. A request rejected at steps 1 to 3 records nothing, so that nobody without the secret can use up a nonce.
5. Only then is the body read as JSON, validated, and processed.

A rejected request receives `401` with the body `{ "error": { "code": "unauthorised", "message": "…" } }` and nothing that says which check failed, a replay included. Praktico writes it to its own security log as a bad signature. A nonce is spent as soon as the request passes step 4, even where the request then fails: a repeat is a new request with a new nonce, a new time, and a new signature.

The limit of 65,536 bytes is a provisional technical bound: 4,000 characters in four-byte form and the escapes of JSON come to well under it. It is not a requirement.

Praktico refuses a one-time value it has already accepted and keeps each for five minutes, as the application does for admission (decided by the owner on 21 November 2026, fw-nonce). That needs a table of values on Praktico's side, which is Praktico's to specify. What removes an expired value is **open, awaits the owner (fw-nonce-removal)**.

## Browser to application: `POST /api/feedback`

Same origin, `Content-Type: application/json`. As for every state-changing route, the application checks the origin of the request (NFR-SE-17 (c)); its answer is that of the rest of the application and is not stated here.

### The request body

Exactly these fields; any other is refused (FR-AU-69). Nothing the browser sends is trusted beyond its shape.

| Field          | Type                 | Bounds                                                                                                                                                                                                                     | Notes                                                                                                                                                    |
| -------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`         | string               | `problem`, `idea`, or `other`                                                                                                                                                                                              | None is preselected in the widget (FR-AU-65)                                                                                                             |
| `message`      | string               | 1 to 4,000 Unicode code points after leading and trailing white space is removed (fw-count-unit); a message that carries a refused character is refused, see "The refused characters"                                      | Plain text; sent as typed (FR-AU-71). The widget counts what remains in code points as well, so that the count it shows is the count the server enforces |
| `route`        | string               | 1 to 200 characters, begins with `/`, no `?`, no `#`, identifiers replaced by their placeholders, as in `/workspaces/[id]` (an illustration, not a real route); the application checks it against a fixed shape (FR-AU-69) | The route pattern of the page the widget was opened from (FR-AU-68 (a))                                                                                  |
| `viewport`     | object               | `width` and `height`, each an integer from 1 to 32,767, in CSS pixels                                                                                                                                                      | Read when the widget is opened (FR-AU-68 (d))                                                                                                            |
| `submissionId` | string, **optional** | Present on a second attempt only, and only the identifier that the failure answer of the first attempt returned. 1 to 64 characters of `[A-Za-z0-9_-]`                                                                     | The one further field FR-AU-69 allows (fw-retry-id). Never made in the browser                                                                           |

The application adds, from the server and never from the body: the application version (FR-AU-68 (b)); the browser name, its major version, and the operating system family, derived from the `User-Agent` header, which is itself neither stored nor sent (FR-AU-68 (c)); the account identifier of the verified session (FR-AU-68 (e)); and, unless the browser sent one, a submission identifier, and the time (FR-AU-68 (f)).

### The refused characters

The owner decided on 21 November 2026 (fw-count-unit) that the 4,000 are counted in code points and that a message with invisible control characters is refused. The set is the one the security report of this engagement gives: a C0 control other than tab (U+0009), line feed (U+000A) and carriage return (U+000D); DEL (U+007F); and a bidirectional override, U+202A to U+202E and U+2066 to U+2069. The interface report does not define a set of its own.

**Open, awaits the owner (no question id yet).** Neither report, and not the answer itself, says whether the set also covers the C1 controls (U+0080 to U+009F), the zero-width characters, and the line and paragraph separators (U+2028, U+2029). The contract refuses none of them until that is decided. The application and Praktico must refuse the same set, so the answer changes both and this page.

### The order of the checks

1. The switch `FEEDBACK_INTAKE_ENABLED` is on; or the route is closed (`404`). This is the switch's scope in this route (fw-switch-scope).
2. A signed-in session; or `401`.
3. The account has acknowledged the Closed α notice (FR-AU-56); or `403`.
4. The limit of FR-AU-78 is applied; or `429`. Whether a send that later fails is counted here is **open, awaits the owner (fw-limit-count)**.
5. The body is validated; or `422`.
6. The submission is delivered to the intake, within 10 seconds.

### The answers

Every error body is `{ "error": { "code", "message" } }`, the body of the application's other routes. The `message` of each is a text for a reader and is **open, awaits the owner (fw-strings)**; the `code` values below are not texts.

| Status                                | When                                                                                                    | Body beyond `error`                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `201`                                 | The intake acknowledged the submission, as new or as one it already held                                | `{ "sent": true }`                                                                                                                                                                                                                                                                                                                                    |
| `401`, code `unauthorised`            | No signed-in session                                                                                    | none                                                                                                                                                                                                                                                                                                                                                  |
| `403`, code `notice_not_acknowledged` | The account has not acknowledged the notice                                                             | none                                                                                                                                                                                                                                                                                                                                                  |
| `404`, code `not_found`               | The switch is off. The form of the answer when the route is closed is the contract's provisional choice | none                                                                                                                                                                                                                                                                                                                                                  |
| `422`, code `invalid`                 | The body is not as above                                                                                | `error.fields`: a list of `{ "field", "rule" }`, where `field` is one of `kind`, `message`, `route`, `viewport`, `submissionId`, and `rule` is one of `required`, `unknown`, `empty`, `too_long`, `format`, `forbidden_character`. The widget states a fault in text beside the field it concerns (FR-AU-80 (d)). The list is the contract's proposal |
| `422`, code `forbidden_character`     | The `message` carries a refused character                                                               | `error.fields` as above, holding `{ "field": "message", "rule": "forbidden_character" }`. The `message` of the error is a text for a reader and is **open, awaits the owner (fw-strings)**                                                                                                                                                            |
| `429`, code `rate_limited`            | Over a limit of FR-AU-78                                                                                | A `Retry-After` header in whole seconds, and `error.retryAfterSeconds`. No identifier is returned: nothing was attempted                                                                                                                                                                                                                              |
| `502`, code `not_sent`                | The intake did not answer within 10 seconds, or answered with anything other than acceptance            | **`submissionId`: the identifier the server issued for this attempt**, beside `error` (fw-retry-id)                                                                                                                                                                                                                                                   |
| `500`, code `internal`                | A fault of the application itself                                                                       | none                                                                                                                                                                                                                                                                                                                                                  |

The `422` is never returned for the identifier alone in a way that tells the browser whether the intake holds it. The application cannot know that.

## Application to intake: `POST /praktico/api/feedback/intake`

Signed as above. `Content-Type: application/json`. The body is exactly these nine fields, in any order, and no other (FR-AU-75, API design):

| Field          | Type   | Bounds                                                                                                                                                                                                                         | Notes                                                                                                       |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `submissionId` | string | 1 to 64 characters of `[A-Za-z0-9_-]`. The application issues a version 4 UUID in its lower-case 36-character form; the intake accepts the wider bound                                                                         | Issued by the server (FR-AU-68 (f)), or the one the browser returned on a retry                             |
| `submittedAt`  | string | ISO 8601 in UTC with milliseconds and `Z`, as `2026-10-08T09:00:00.000Z`                                                                                                                                                       | The time of the attempt that carries it. On a repeat the intake keeps the time of the first it accepted     |
| `kind`         | string | `problem`, `idea`, `other`                                                                                                                                                                                                     |                                                                                                             |
| `message`      | string | 1 to 4,000 Unicode code points; no refused character, see "The refused characters" (fw-count-unit)                                                                                                                             | Already trimmed by the application; the intake does not trim or alter it                                    |
| `route`        | string | As in the browser's field                                                                                                                                                                                                      |                                                                                                             |
| `appVersion`   | string | 1 to 64 characters of `[0-9A-Za-z.+-]`, as `0.1.0`                                                                                                                                                                             |                                                                                                             |
| `browser`      | object | `name`: string, 1 to 64 characters; `major`: integer from 0 to 9,999, or `null` where it is unknown; `osFamily`: string, 1 to 64 characters. An agent the application cannot name has `name` and `osFamily` equal to `unknown` | The names of the three keys are the contract's choice; the specification gives the three parts and no names |
| `viewport`     | object | `width` and `height`, integers from 1 to 32,767                                                                                                                                                                                |                                                                                                             |
| `accountId`    | string | 1 to 64 characters of `[A-Za-z0-9_-]`                                                                                                                                                                                          | The application's own user identifier; never an email address (FR-AU-68 (e))                                |

A body with a missing field, a field of another type, a value outside its bounds, a field not listed, or a repeated key is invalid. Validation is strict.

### Matching a held submission

A submission is held when the intake has a row with the same `submissionId` **and** the same `accountId` (fw-retry-id). An identifier alone is never a match: another account's identifier is a new submission. So the row's unique key is the pair. A row whose `accountId` has been set to null (below) matches nothing.

### The answers

| Status                            | When                                                                                                                                | Body                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `201`                             | The submission is new and is stored                                                                                                 | `{ "accepted": true, "duplicate": false }`     |
| `200`                             | The pair is held. Nothing is stored again, even where the kind or the message differs (FR-AU-75; see "The retry")                   | `{ "accepted": true, "duplicate": true }`      |
| `401`, code `unauthorised`        | A check of "Verification at Praktico" failed before step 5                                                                          | the error body                                 |
| `422`, code `invalid`             | Step 5: the body is not as above, or `Content-Type` is not `application/json`                                                       | the error body                                 |
| `422`, code `forbidden_character` | Step 5: the `message` carries a refused character. Praktico refuses it as well, and does not rely on the application having done so | the error body, which never echoes the message |
| any other                         | A limit or a fault on Praktico's side. Whether Praktico limits the route, and with what, is Praktico's to state                     |                                                |

The application treats **only** `200` or `201` with a body whose `accepted` is exactly `true` as success. A `5xx`, a `4xx`, a body of another shape, a closed connection, and no answer within 10 seconds are one failure to it, and it answers the browser `502`.

## Application to intake: `POST /praktico/api/feedback/pseudonymise`

Signed as above. The body is exactly one field: `{ "accountId": "…" }`, as bounded above.

| Status       | When                                                                                                                                     | Body                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `200`        | Praktico set `accountId` to null on every submission that carried it. The count may be zero, and then the call still succeeds (FR-AU-79) | `{ "accepted": true, "changed": 0 }`, where `changed` is a whole number from 0 up |
| `401`, `422` | As above                                                                                                                                 | the error body                                                                    |

Only the account identifier changes. The kind, the message, the context, and the status stay (FR-AU-79). The call is safe to repeat: the second answer is `200` with `changed` 0. The application treats only `200` with `accepted` exactly `true` and a whole-number `changed` as acknowledgement, and otherwise records the step as owed and repeats it on its timer, each repeat a new request with a new nonce (FR-AU-58, NFR-RE-15). How long one attempt waits is not stated by the specification and is the application's slice to fix.

## The retry

1. A first attempt carries no `submissionId`. The server issues one, delivers with it, and on acceptance forgets it.
2. When the attempt fails with `502`, the answer returns that identifier. The application keeps nothing (FR-AU-76).
3. The browser keeps the identifier with the kind and the message, in the open widget, and sends it back as `submissionId` when the user sends again. It forgets it once a send succeeds.
4. The application checks that the field has the form above, reuses the identifier, and delivers again with a **new** nonce, a new timestamp, a new signature, and a `submittedAt` of the new attempt. It does not make a new identifier.
5. The intake matches on identifier and account together. If the first attempt had reached it, the answer is `200` with `duplicate` true, the application answers the browser `201`, and the team has one row. If it had not, the answer is `201`.
6. A `429` carries no identifier, because nothing was attempted. A retry after it carries none.
7. The application does not queue a submission, and the browser does not send a second one by itself.

**Open, awaits the owner (fw-retry-edited).** The rule keeps the first message the intake accepted. If the user changes the text between the two attempts and the first had reached the intake, the change is dropped without the user being told. The alternatives, to update the row, to keep both, or to drop the identifier once the text changes, each need an owner's answer; this page chooses none.

**Open, awaits the owner (fw-limit-count).** Whether the second attempt, or a failed first one, uses up a place in the allowance of FR-AU-78.

## Deletion, and the switch

Step (c) of an account deletion calls `pseudonymise` as above. It is built in `src/lib/account/feedback-step.ts`, the one place that reads `FEEDBACK_INTAKE_ENABLED`, and its client is the one the Feedback Widget's slice brings. With the switch off the step makes no call and is recorded as skipped. With it on, the control, the route, and the step are on together (fw-switch-scope). Turned on before Praktico has the route and both secrets are set, every deletion stops at step (c) and is repeated each hour. Setting the secrets and turning the switch on are the owner's.

## What each side tests against this page

The application's client, with a stub of Praktico:

- the three headers, the message, and the signature, against the worked examples below;
- a new nonce, time, and signature on every attempt, and the same `submissionId` on a retry;
- the exact set of nine keys in the intake body, and no `User-Agent`, network address, session identifier, email address, or document data in it;
- success only for `200` or `201` with `accepted` exactly `true`; failure, and `502` with the identifier, for every other answer and for 10 seconds without one;
- `pseudonymise`: acknowledgement only for `200` with `accepted` `true` and a whole-number `changed`, and repetition otherwise;
- the answers of the browser route above, including `404` with the switch off, `403` before the notice is acknowledged, and `422` with `fields`.
- the count in code points (a message of 4,000 code points that is more than 4,000 UTF-16 units is accepted, and one of 4,001 is refused), and each class of refused character, each refused with `forbidden_character`;

Praktico's routes, with the application's client or a test caller:

- every check of "Verification at Praktico", each rejected with an identical `401`, a replay among them, and a request rejected there recording no nonce;
- the nine fields, strictly: each missing field, each wrong type, each out-of-bounds value, one extra field, and a repeated key give `422` and store nothing;
- each class of refused character in the `message`, refused with `422` and `forbidden_character`, and nothing stored;
- a new submission gives `201`; the same pair again gives `200` with `duplicate` true and one row; the same identifier with another account gives `201` and a second row;
- `pseudonymise` nulls the account identifier of every row it names, keeps every other column, answers `changed` with the count, and answers `changed` 0 on a repeat and for an account with no rows;
- no message appears in any log, and no secret in any response.

## Two worked examples

With the secret `test-secret-not-for-use`, which is too short to be accepted as a real one and exists only for these two vectors, the time `1791450000`, the paths of the two routes, and a nonce for each, in place of a random one:

| Request                                                                                                             | Nonce                              | `X-Ekdotico-Signature`                                             |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `POST /praktico/api/feedback/intake` with the 345-byte body below                                                   | `00112233445566778899aabbccddeeff` | `07a07f3dbd9a7ac3140183024cdad7d70d8709ec9696933de2b391b365e751ef` |
| `POST /praktico/api/feedback/pseudonymise` with the 48-byte body `{"accountId":"a1b2c3d4e5f60718293a4b5c6d7e8f90"}` | `ffeeddccbbaa99887766554433221100` | `b517b78a219de72537fe151a9f3eb7fbe840d779a8b5bb61745f2da933fb8dd1` |

The first body, written as one line with no white space between its tokens:

```json
{
  "submissionId": "6f1d2c9e-3b7a-4f58-9a0e-2d4c8b1e7a35",
  "submittedAt": "2026-10-08T09:00:00.000Z",
  "kind": "problem",
  "message": "The page does not scroll.",
  "route": "/workspaces/[id]",
  "appVersion": "0.1.0",
  "browser": { "name": "Firefox", "major": 140, "osFamily": "macOS" },
  "viewport": { "width": 1440, "height": 900 },
  "accountId": "a1b2c3d4e5f60718293a4b5c6d7e8f90"
}
```

Both values were computed twice, by Node's `createHmac` and by Web Crypto, on 21 November 2026, and agree. Those are two code paths in one language, not two languages; a second implementation in another language is the better check, and Praktico's tests are the natural place for it.

## Not on this page

The list page, who may open it, the deletion of one submission, and the removal of feedback after its retention are Praktico's, and the owner's questions fw-team-access and fw-retention are open. The three statuses are decided (fw-statuses) and are not sent on the wire. The texts the widget and Praktico show are the owner's (fw-strings). The privacy notice is being written for the owner's approval (fw-privacy-link). The notice version is decided (fw-notice-version).
