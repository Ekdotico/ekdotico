# The feedback intake: wire contract

> **PROVISIONAL. Praktico owns the intake's side of this contract.**
>
> The Feedback Widget (FR-AU-59 to FR-AU-80) sends feedback to the feedback intake, a section of Praktico. Praktico's specification does not yet contain the section (register Q25). So that the application's client and Praktico's two routes can be written and tested in parallel, this page states what the specification fixes, what the owner decided on 21 November 2026, and, for the rest, a provisional form. **When Praktico's specification states a format, that statement replaces the provisional parts of this page**, and the application changes to match it.
>
> The signed form is the admission channel's (`docs/contracts/admission-signature.md`), shared, as the owner decided. That form is itself provisional and Praktico's to own; this page does not declare it final.
>
> Draft, updated for the owner's answers of 21 November 2026 on the paths and the one-time value. Read against the `docs` repository at commit `765c6d9` and its draft pull request 139, which records the four answers below as margin notes. No code accompanies this page: the stub and the client come with the application's slice.

## What the owner decided, 21 November 2026

| Question             | Answer                                                                                                                                                                                                                                                                                                               | Where it shows on this page                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| fw-hosting           | Build, then move. The intake is built on Cloudflare Workers now and only the founding team uses it until Praktico has moved to Frankfurt; D78 stands as the destination                                                                                                                                              | Not a wire matter; the paths below are the same on either host                       |
| fw-switch-scope      | `FEEDBACK_INTAKE_ENABLED` is one switch: it shows the widget, opens the sending route, and turns on deletion step (c)                                                                                                                                                                                                | "Browser to application", "Deletion"                                                 |
| fw-signature         | The signature covers a one-time value, the method, the path, the time, and the body, in one form shared with the admission channel. This replaces "time and body" in FR-AU-75                                                                                                                                        | "The signed form"                                                                    |
| fw-retry-id          | When a send fails, the failure answer returns the server-issued submission identifier; the browser sends it back on the retry; Praktico matches on identifier and account together. FR-AU-69 allows this one further field; FR-AU-68 (f), FR-AU-76, and FR-AU-77 stay true                                           | "Browser to application", "The retry"                                                |
| fw-intake-path       | Praktico's two routes are `POST /api/feedback/intake` and `POST /api/feedback/pseudonymise`, under the tool's base path, which is `/praktico`. The signed path is therefore `/praktico/api/feedback/intake` and `/praktico/api/feedback/pseudonymise`, on the host `internal.ekdoti.co`                              | "The three requests", "The signed form", the worked examples                         |
| fw-nonce             | Praktico keeps each one-time value for five minutes and refuses a repeat. Each expired value is removed by the request that records a new one (fw-nonce-removal)                                                                                                                                                     | "Verification at Praktico", step 4                                                   |
| fw-statuses          | The three statuses a submission takes in Praktico are "New", "Read", and "Closed", and a new submission is "New". The status is set by the team in Praktico and is never sent by the application                                                                                                                     | Not on the wire                                                                      |
| fw-privacy-link      | The application's privacy notice is a page of the application at `/privacy`, readable without signing in, and the widget ships with it (fw-privacy-page). Its text is approved as the base, and it is published to test users once Praktico has moved (fw-privacy-text, fw-privacy-hosting)                          | Not on the wire                                                                      |
| fw-count-unit        | The 4,000 characters of the message are counted in Unicode code points, and a message that carries an invisible control character is refused                                                                                                                                                                         | The `message` field, "The refused characters", the two `forbidden_character` answers |
| fw-refused-set       | The refused set also covers the C1 controls (U+0080 to U+009F). The zero-width characters and U+2028 and U+2029 are allowed                                                                                                                                                                                          | "The refused characters"                                                             |
| fw-field-bounds      | The bounds of this page stand: `appVersion` 1 to 64 characters of `[0-9A-Za-z.+-]`, the viewport 1 to 32,767, and the major version of the browser a whole number from 0 to 9,999 or `null`. Praktico's amendment matches them                                                                                       | The `appVersion`, `browser`, and `viewport` fields of both routes                    |
| fw-signed-posture    | Praktico's two signed routes have a route kind of their own, "signed"                                                                                                                                                                                                                                                | Nothing on this page depends on it                                                   |
| fw-notice-version    | When the sentence on feedback joins the Closed α notice, the version of the notice is raised to 2, so that every account sees it once more                                                                                                                                                                           | Not on the wire                                                                      |
| fw-wire-align        | This page's answers stand: 201 for a new submission and 200 for a pair already held, 422 for a body that breaks a rule (`forbidden_character` for a refused character). The body limit is Praktico's figure, 32,768 bytes, refused with 413 before the body is read. Praktico's amendment is changed to match        | "The answers" of both Praktico routes, "Verification at Praktico", step 1            |
| fw-limit-count       | Only a submission the intake accepted counts against the 5 in 10 minutes and the 30 in 24 hours of FR-AU-78; a send that fails does not                                                                                                                                                                              | "Browser to application", step 4; "The retry"                                        |
| fw-retry-edit        | An edited message is a new submission: the browser drops the identifier when the text or the kind changes. On a match the intake changes nothing                                                                                                                                                                     | "The retry"                                                                          |
| fw-detach-wait       | The deletion step waits 15 seconds before it makes the detach call (`pseudonymise`), longer than the 10 seconds a send may take (FR-AU-77), so that a message sent in the same second as the deletion cannot arrive after the detach; and an alarm is raised when a deletion has been stuck at step (c) for 24 hours | "Deletion, and the switch"                                                           |
| fw-intake-switch     | `FEEDBACK_INTAKE_ENABLED` goes on in the release that adds the widget, and the release check refuses a widget without it                                                                                                                                                                                             | "Deletion, and the switch"                                                           |
| fw-retention         | Feedback is deleted by a written procedure that the owner runs by hand, with a dated reminder set when the last release is known                                                                                                                                                                                     | Not on the wire                                                                      |
| fw-intake-limit      | Praktico limits the whole signed channel, both routes together, to 60 requests a minute, counted after the signature verifies                                                                                                                                                                                        | The answers of the intake                                                            |
| fw-nonce-removal     | The request that records a new one-time value deletes the expired ones                                                                                                                                                                                                                                               | "Verification at Praktico", step 4                                                   |
| fw-status-permission | `feedback.read` reads the list and `feedback.update` sets a status; administrators hold both to begin with                                                                                                                                                                                                           | Not on the wire                                                                      |
| fw-team-access       | Who may open the list in Praktico is decided by a named permission, held by administrators to begin with (capability-admins); with fw-status-permission, `feedback.read` reads the list and `feedback.update` sets a status                                                                                          | Not on the wire                                                                      |

## What is still open

Each of these is the owner's, and none is settled here. Where this page touches one it says "open, awaits the owner" and names the question.

| Question   | What it leaves open                                                                         | Where it touches this page |
| ---------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| fw-strings | Every text a reader sees, the `message` of each error body returned to the browser included | The error bodies           |

Praktico's limit on the intake is decided (fw-intake-limit, in "The answers" of the intake). The path of the section is decided (fw-intake-path).

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

### Changing the secret

The secret is changed in this order, so that no send is lost (fw-secret-rotation). Praktico is given the new secret first and keeps the old one beside it; the application is given the new secret second; the old one is removed from Praktico last.

1. Make the new secret, of the form above and different from every other secret.
2. On Praktico, set `FEEDBACK_SECRET_PREVIOUS` to the old value first, and then `FEEDBACK_SECRET` to the new value, or set both in one operation. Praktico then accepts a request signed with either.
3. On the application, set `FEEDBACK_SECRET` to the new value and restart it. The application signs with that one value. It holds no second value and needs none.
4. At least 11 minutes after the last instance of the application has started with the new value, remove `FEEDBACK_SECRET_PREVIOUS` from Praktico. Praktico accepts a signed time up to 300 seconds ahead of its own clock and up to 300 seconds behind it, so a request signed with the old value can stay valid for about 601 seconds.

Done in another order, the change loses sends: an application given the new value before Praktico is refused on every request until Praktico has it. Setting and removing a secret is the owner's.

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

1. Each header occurs once and matches its pattern, the target is exactly the path of the route with no query string, no trailing slash and no percent-encoding, the method is `POST`, and the body is at most 32,768 bytes, otherwise it is refused with `413` before it is read (fw-wire-align); or the request is rejected.
2. The absolute difference between Praktico's clock, in whole seconds, and the timestamp is at most 300; or the request is rejected.
3. The signature is recomputed and compared, as 32 bytes, in constant time; or the request is rejected.
4. The nonce is recorded by one atomic insert under a unique constraint, and kept until the signed time is more than 5 minutes in the past; a request whose nonce is already held is rejected. A request rejected at steps 1 to 3 records nothing, so that nobody without the secret can use up a nonce. The request that records a new nonce deletes the expired ones (fw-nonce-removal).
5. Only then is the body read as JSON, validated, and processed.

A rejected request receives `401` with the body `{ "error": { "code": "unauthorised", "message": "…" } }` and nothing that says which check failed, a replay included. Praktico writes it to its own security log as a bad signature. A nonce is spent as soon as the request passes step 4, even where the request then fails: a repeat is a new request with a new nonce, a new time, and a new signature.

The limit is 32,768 bytes, the figure of Praktico (fw-wire-align). The body of a submission is far smaller: 4,000 code points in four-byte form are 16,000 bytes, and the other fields add a few hundred. A sender that wrote every non-ASCII character as a six-byte escape could exceed it with a long message of such characters; the application writes them as they are. A body over the limit is answered `413` with the code `too_large` and the error body, and records nothing.

Praktico refuses a one-time value it has already accepted and keeps each for five minutes, as the application does for admission (decided by the owner on 21 November 2026, fw-nonce). That needs a table of values on Praktico's side, which is Praktico's to specify. Each expired value is removed by the request that records a new one (fw-nonce-removal).

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

The owner decided on 21 November 2026 (fw-count-unit, fw-refused-set) that the 4,000 are counted in code points and that a message with an invisible control character is refused. The refused set is: a C0 control other than tab (U+0009), line feed (U+000A) and carriage return (U+000D); DEL (U+007F); a C1 control (U+0080 to U+009F); and a bidirectional override, U+202A to U+202E and U+2066 to U+2069. A lone surrogate, that is text that is not well-formed, is refused as well (fw-surrogate). The zero-width characters and the line and paragraph separators (U+2028 and U+2029) are allowed. The application and Praktico refuse the same set.

### The order of the checks

1. The switch `FEEDBACK_INTAKE_ENABLED` is on; or the route is closed (`404`). This is the switch's scope in this route (fw-switch-scope).
2. A signed-in session; or `401`.
3. The account has acknowledged the Closed α notice (FR-AU-56); or `403`.
4. The limit of FR-AU-78 is applied: an account that already has 5 accepted submissions in the last 10 minutes, or 30 in the last 24 hours, receives `429`. Only a submission the intake accepted counts; a send that fails does not (fw-limit-count).
5. The body is validated; or `422`.
6. The submission is delivered to the intake, within 10 seconds.

### The answers

Every error body is `{ "error": { "code", "message" } }`, the body of the application's other routes. The `message` of each is a text for a reader and is **open, awaits the owner (fw-strings)**; the `code` values below are not texts.

| Status                                | When                                                                                                    | Body beyond `error`                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `201`                                 | The intake acknowledged the submission, as new or as one it already held                                | `{ "sent": true }`                                                                                                                                                                                                                                                                                                                                    |
| `401`, code `unauthenticated`         | No signed-in session                                                                                    | none                                                                                                                                                                                                                                                                                                                                                  |
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

| Status                            | When                                                                                                                                                                                          | Body                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `201`                             | The submission is new and is stored                                                                                                                                                           | `{ "accepted": true, "duplicate": false }`     |
| `200`                             | The pair is held. Nothing is stored again, even where the kind or the message differs (FR-AU-75; see "The retry")                                                                             | `{ "accepted": true, "duplicate": true }`      |
| `413`, code `too_large`           | The body is over 32,768 bytes. Refused before the body is read, and before the signature is checked                                                                                           | the error body                                 |
| `401`, code `unauthorised`        | A check of "Verification at Praktico" failed before step 5                                                                                                                                    | the error body                                 |
| `422`, code `invalid`             | Step 5: the body is not as above, or `Content-Type` is not `application/json`                                                                                                                 | the error body                                 |
| `422`, code `forbidden_character` | Step 5: the `message` carries a refused character. Praktico refuses it as well, and does not rely on the application having done so                                                           | the error body, which never echoes the message |
| `429`                             | Praktico's limit on the whole signed channel, 60 requests a minute over both routes together, counted after the signature verifies (fw-intake-limit). A `Retry-After` header in whole seconds | the error body                                 |
| any other                         | A fault on Praktico's side                                                                                                                                                                    |                                                |

The application treats **only** `200` or `201` with a body whose `accepted` is exactly `true` as success. A `5xx`, a `4xx`, a body of another shape, a closed connection, and no answer within 10 seconds are one failure to it, and it answers the browser `502`.

## Application to intake: `POST /praktico/api/feedback/pseudonymise`

Signed as above. The body is exactly one field: `{ "accountId": "…" }`, as bounded above.

| Status                  | When                                                                                                                                     | Body                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `200`                   | Praktico set `accountId` to null on every submission that carried it. The count may be zero, and then the call still succeeds (FR-AU-79) | `{ "accepted": true, "changed": 0 }`, where `changed` is a whole number from 0 up |
| `413`, code `too_large` | As for `intake`                                                                                                                          | the error body                                                                    |
| `401`, `422`            | As above                                                                                                                                 | the error body                                                                    |

Only the account identifier changes. The kind, the message, the context, and the status stay (FR-AU-79). The call is safe to repeat: the second answer is `200` with `changed` 0. The application treats only `200` with `accepted` exactly `true` and a whole-number `changed` as acknowledgement, and otherwise records the step as owed and repeats it on its timer, each repeat a new request with a new nonce (FR-AU-58, NFR-RE-15). The deletion step waits 15 seconds before it makes the call, which is longer than the 10 seconds a send may take, so that a message sent in the same second as the deletion cannot arrive after the detach; this is a delay before the call and not a timeout on its answer (fw-detach-wait). How long one attempt then waits for the answer is not stated by the specification or by the owner's answer, and is the application's slice to fix. An alarm is raised when a deletion has been stuck at step (c) for 24 hours (fw-detach-wait); how it is raised is the application's slice.

## The retry

1. A first attempt carries no `submissionId`. The server issues one, delivers with it, and on acceptance forgets it.
2. When the attempt fails with `502`, the answer returns that identifier. The application keeps nothing (FR-AU-76).
3. The browser keeps the identifier with the kind and the message, in the open widget, and sends it back as `submissionId` when the user sends again. It forgets it once a send succeeds, and at once if the user changes the text or the kind: an edited message is a new submission, so the next send is a first attempt and the server issues a new identifier (fw-retry-edit).
4. The application checks that the field has the form above, reuses the identifier, and delivers again with a **new** nonce, a new timestamp, a new signature, and a `submittedAt` of the new attempt. It does not make a new identifier.
5. The intake matches on identifier and account together. If the first attempt had reached it, the answer is `200` with `duplicate` true, the application answers the browser `201`, and the team has one row. If it had not, the answer is `201`.
6. A `429` carries no identifier, because nothing was attempted. A retry after it carries none.
7. The application does not queue a submission, and the browser does not send a second one by itself.

**Decided (fw-retry-edit).** An edited message is a new submission. If the first attempt had in fact reached the intake, the team then holds both messages. On a match, that is the same identifier and the same account with the text and the kind unchanged, the intake changes nothing.

**Decided (fw-limit-count).** Only a submission the intake accepted counts against the allowance of FR-AU-78. An attempt that fails is not counted. A retry that the intake acknowledges as already held counts once, since it is the first acceptance the application hears of.

## Deletion, and the switch

Step (c) of an account deletion calls `pseudonymise` as above. It is built in `src/lib/account/feedback-step.ts`, the one place that reads `FEEDBACK_INTAKE_ENABLED`, and its client is the one the Feedback Widget's slice brings. With the switch off the step makes no call and is recorded as skipped. With it on, the control, the route, and the step are on together (fw-switch-scope). Turned on before Praktico has the route and both secrets are set, every deletion stops at step (c) and is repeated each hour. The switch goes on in the release that adds the widget, and the release check refuses a widget without it (fw-intake-switch). Setting the secrets and turning the switch on are the owner's.

## What each side tests against this page

The application's client, with a stub of Praktico:

- the three headers, the message, and the signature, against the worked examples below;
- a new nonce, time, and signature on every attempt, and the same `submissionId` on a retry;
- the exact set of nine keys in the intake body, and no `User-Agent`, network address, session identifier, email address, or document data in it;
- success only for `200` or `201` with `accepted` exactly `true`; failure, and `502` with the identifier, for every other answer and for 10 seconds without one;
- `pseudonymise`: acknowledgement only for `200` with `accepted` `true` and a whole-number `changed`, and repetition otherwise;
- the answers of the browser route above, including `404` with the switch off, `403` before the notice is acknowledged, and `422` with `fields`.
- only an accepted submission counts against the limits, and a failed one does not; and the identifier is dropped when the text or the kind changes;
- the count in code points (a message of 4,000 code points that is more than 4,000 UTF-16 units is accepted, and one of 4,001 is refused), and each class of refused character (a C0 control, DEL, a C1 control, a bidirectional override), each refused with `forbidden_character`, while a zero-width character, U+2028, and U+2029 are accepted;

Praktico's routes, with the application's client or a test caller:

- every check of "Verification at Praktico", each rejected with an identical `401`, a replay among them, and a request rejected there recording no nonce;
- the nine fields, strictly: each missing field, each wrong type, each out-of-bounds value, one extra field, and a repeated key give `422` and store nothing;
- each class of refused character in the `message` (a C0 control, DEL, a C1 control, a bidirectional override), refused with `422` and `forbidden_character` and nothing stored, and a zero-width character, U+2028, and U+2029 accepted;
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

The list page and the deletion of one submission are Praktico's, and who may open the list is decided (fw-team-access): a named permission, held by administrators to begin with, with `feedback.read` to read and `feedback.update` to set a status (fw-status-permission). The three statuses are decided (fw-statuses) and are not sent on the wire. Feedback is deleted by a written procedure (fw-retention). The texts the widget and Praktico show are the owner's (fw-strings). The privacy notice is a page of the application at `/privacy` (fw-privacy-link, fw-privacy-page). The notice version is decided (fw-notice-version).
