# The admission signature: wire format

> **PROVISIONAL. Praktico owns this contract.**
>
> The suite owner decided on 8 October 2026 that the format of the signed admission requests belongs to Praktico's specification, which does not contain it yet (register Q25). So that accounts can be created before Praktico is written, the application defines the format below and builds against it.
>
> **When Praktico's specification states a format, that statement replaces this page**, and the application changes to match it. Everything that depends on the format is in one module, `src/lib/admission/signature.ts`, with its tests, so that the change is a contained one. Until then, a caller of the admission endpoints follows this page exactly.
>
> Read against Docs commit `f4ec614`. Not yet in the register: the row is at the end of this page.

## What the specification fixes

These are requirements (FR-AU-89; API design, "Admission") and are not provisional:

- Each request is one HTTPS request signed with HMAC-SHA-256.
- The signature covers the request time, the method, the path, and the exact body.
- The key is the admission secret, held only in the server environment of the application and of the caller. It is not the feedback secret, and it is never sent to a browser.
- The application accepts a request only where the signature verifies and the signed time is within 5 minutes of its own, and rejects any other before any processing.
- The endpoints carry no session, and are limited to 60 requests a minute in all.
- Neither the token of an invitation nor its link is ever returned.

## What this page adds

Everything below is the application's choice and is provisional.

### The setting

The admission secret is read from `ADMISSION_SECRET`. It is at least 32 bytes from a cryptographically secure source, and differs for each environment (NFR-SE-17 (e)).

### The two headers

| Header                 | Value                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `X-Ekdotico-Timestamp` | The request time: seconds since the Unix epoch, in decimal digits, with no sign, fraction, or padding |
| `X-Ekdotico-Signature` | The signature: 64 lower-case hexadecimal digits                                                       |

### The signed string

Four parts, joined by a single line feed (`\n`, byte `0x0A`), with no line feed after the last:

```
<timestamp>\n<METHOD>\n<path>\n<body>
```

| Part        | Exactly                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timestamp` | The value of `X-Ekdotico-Timestamp`, byte for byte                                                                                                                |
| `METHOD`    | The HTTP method in upper case: `POST`, `GET`, or `DELETE`                                                                                                         |
| `path`      | The path of the request as sent, beginning with `/`, with its query string where it has one, and without scheme or host. For example `/api/admission/invitations` |
| `body`      | The bytes of the request body exactly as sent. A request without a body signs the empty string, so its signed string ends with a line feed                        |

The signature is `HMAC-SHA-256(key = ADMISSION_SECRET as UTF-8 bytes, message = the signed string as UTF-8 bytes)`, written in lower-case hexadecimal.

The caller signs the bytes it sends. The application verifies against the bytes it received, before parsing them: a body that is parsed and written out again does not verify.

### Verification, in order

1. Both headers are present and well formed, or the request is rejected.
2. The timestamp is within 300 seconds of the application's clock, in either direction, or the request is rejected.
3. The signature is recomputed and compared in constant time, or the request is rejected.
4. Only then is the body read as JSON and the request processed.

A rejected request receives `401` with the error body of the application and nothing that says which check failed. It is written to the security log as a bad signature (NFR-SE-19).

### The three requests

Bodies are JSON, `Content-Type: application/json`.

**Create.** `POST /api/admission/invitations`

```json
{
  "email": "person@example.com",
  "requestId": "a caller-issued identifier, unique for each intended invitation"
}
```

| Answer                           | When                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `201` with the invitation        | An invitation was created and its email handed over. A pending invitation to the same address was revoked and replaced |
| `200` with the invitation        | The same `requestId` was sent before; nothing changed                                                                  |
| `409` with code `account_exists` | The address already belongs to an account; nothing was created                                                         |
| `422`                            | The body is not as above, or the address is not an email address                                                       |

**List.** `GET /api/admission/invitations`

`200` with `{ "invitations": [ … ] }`.

**Revoke.** `DELETE /api/admission/invitations/<id>`

| Answer                        | When                                            |
| ----------------------------- | ----------------------------------------------- |
| `200` with the invitation     | A pending invitation was revoked                |
| `404`                         | No invitation has that identifier               |
| `409` with code `not_pending` | The invitation is accepted, revoked, or expired |

**An invitation**, wherever one is returned:

```json
{
  "id": "…",
  "email": "person@example.com",
  "state": "pending",
  "createdAt": "2026-10-08T09:00:00.000Z",
  "expiresAt": "2026-11-07T09:00:00.000Z"
}
```

`state` is `pending`, `accepted`, `revoked`, or `expired`. `email` is absent once the address has been cleared. Times are ISO 8601 in UTC.

Every answer over the limit is `429` and says when the caller may try again.

### A worked example

With the secret `test-secret-not-for-use`, the request

```
GET /api/admission/invitations
X-Ekdotico-Timestamp: 1791450000
```

signs the string `1791450000\nGET\n/api/admission/invitations\n`. The test suite of `src/lib/admission/signature.ts` holds this vector with its signature, so that a second implementation can be checked against it.

## The row for the register

| What is open                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Where                                                                    | Recommendation                                                                                                           | Alternatives                                                                                                                                                                                                   | Who decides                                    | α 0.1.0                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| **The wire format of the admission signature.** FR-AU-89 fixes the algorithm, what is signed, and the 5 minutes. It gives no header names, no encoding, no signed string, no setting name for the secret, and no answer for any outcome. The owner's decision of 8 October 2026: the format belongs to Praktico's specification; until that states one, the application builds the format recorded in `docs/contracts/admission-signature.md` of the `ekdotico` repository, as provisional | FR-AU-89, FR-AU-57; API design, "Admission"; NFR-SE-05 (b); register Q25 | Praktico's specification adopts the recorded format as it stands, since the application and its command already speak it | (1) Praktico's specification states another format, and the application's one module is rewritten to it. (2) HTTP Message Signatures (RFC 9421), which does not map exactly onto the four parts FR-AU-89 names | The owner, with Praktico's specification (Q25) | In the release, as recorded and provisional |
