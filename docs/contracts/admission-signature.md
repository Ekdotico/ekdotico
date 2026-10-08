# The admission signature: wire format

> **PROVISIONAL. Praktico owns this contract.**
>
> The suite owner decided on 8 October 2026 that the format of the signed admission requests belongs to Praktico's specification, which does not contain it yet (register Q25). So that accounts can be created before Praktico is written, the application defines the format below and builds against it.
>
> **When Praktico's specification states a format, that statement replaces this page**, and the application changes to match it. Everything that depends on the format is in one module, `src/lib/admission/signature.ts`, with its tests, so that the change is a contained one. The header comment of that module repeats this notice. Until then, a caller of the admission endpoints follows this page exactly.
>
> Read against Docs commit `f4ec614`. Not yet in the register: the row is at the end of this page.

This page is the wire format only. The token of an invitation, its expiry of 30 days (a setting), its email, and the clearing of its address 30 days after it is revoked or expires are in FR-AU-89 and are not repeated here.

## What the specification fixes

These are requirements and are not provisional (FR-AU-89; API design, "Admission"; register D94, D110, D113):

- Each request is one HTTPS request signed with HMAC-SHA-256.
- The signature covers the request time, the method, the path, and the exact body.
- The key is the admission secret, held only in the server environment of the application and of the caller. It is not the feedback secret, and it is never sent to a browser.
- The application accepts a request only where the signature verifies and the signed time is within 5 minutes of its own, and rejects any other before any processing.
- The endpoints carry no session.
- The three paths, the fields of each request, the four states, and what each request does: FR-AU-89 (a) to (c).
- Neither the token of an invitation nor its link is ever returned.
- The endpoints are limited to 60 requests in any minute in all, an initial value held in configuration, and a request whose signature does not verify is rejected whatever the count (NFR-SE-07).

## What this page adds

The names of the setting and of the headers, the signed string, the order of verification, the limits on the form of each part, and the status codes and JSON shapes are the application's choice and are provisional.

### The setting

The admission secret is read from `ADMISSION_SECRET`. The key is the value of the setting exactly as set, as UTF-8 bytes, never decoded and never trimmed: at least 43 characters of `[A-Za-z0-9_-]`, carrying 256 bits from a cryptographically secure source. It differs for each environment (NFR-SE-17 (e)).

There is one key at a time. That is enough while the command reads the same environment as the application; a second, previous key that the application also accepts during a rotation is added when Praktico calls from another server.

### The two headers

Each occurs exactly once.

| Header                 | Value                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `X-Ekdotico-Timestamp` | The request time in whole seconds since the Unix epoch: exactly ten decimal digits, matching `^[1-9][0-9]{9}$` |
| `X-Ekdotico-Signature` | The signature: exactly 64 lower-case hexadecimal digits, matching `^[0-9a-f]{64}$`                             |

Upper-case hexadecimal is rejected, not folded.

### The signed message

The message is a sequence of bytes: the UTF-8 bytes of

```
<timestamp>\n<METHOD>\n<path>\n
```

followed by the bytes of the request body, unchanged. `\n` is a single line feed, byte `0x0A`. The body is never decoded to text before verification.

| Part        | Exactly                                                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timestamp` | The value of `X-Ekdotico-Timestamp`, byte for byte                                                                                                                                                                                                                           |
| `METHOD`    | `POST`, `GET`, or `DELETE`, in upper case                                                                                                                                                                                                                                    |
| `path`      | Exactly `/api/admission/invitations`, or `/api/admission/invitations/<id>` with `<id>` as the application returned it, 1 to 64 characters of `[A-Za-z0-9_-]`. No query string, no trailing slash, no percent-encoding. A request whose target has any other form is rejected |
| body        | The bytes of the request body exactly as sent, at most 4,096 of them. A request without a body adds nothing, so its message ends with the third line feed                                                                                                                    |

The signature is `HMAC-SHA-256(key, message)`, written as 64 lower-case hexadecimal digits.

The caller signs the bytes it sends. The application verifies against the bytes it received: a body that is parsed and written out again does not verify.

### Verification, in order

1. Each header occurs once and matches its pattern, the target has one of the two forms above, and the body is at most 4,096 bytes; or the request is rejected.
2. The absolute difference between the application's clock, in whole seconds, and the timestamp is at most 300; or the request is rejected.
3. The signature is recomputed and compared, as 32 bytes, in constant time; or the request is rejected.
4. The limit of NFR-SE-07 is applied: a verified request over it receives `429` with `Retry-After` in seconds, and is not processed. A request that was rejected above does not count toward the limit, so that nobody without the secret can use it up.
5. Only then is the body read as JSON and the request processed.

A rejected request receives `401` with the error body of the application and nothing that says which check failed. It is written to the security log as a bad signature (NFR-SE-19). Since only a verified request can receive a `429`, the two answers do not conflict.

### The three requests

Bodies are JSON, `Content-Type: application/json`.

**Create.** `POST /api/admission/invitations`

```json
{ "email": "person@example.com", "requestId": "0b9f6c1e-5d1c-4a55-9d53-1f3a2f6f7a10" }
```

`requestId` is issued by the caller, one for each invitation it intends: 1 to 64 characters of `[A-Za-z0-9_-]`. It is looked up first, before the account is checked and before anything is revoked, so that a request sent twice, or replayed, changes nothing.

| Answer                           | When                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `201` with the invitation        | An invitation was created and its email handed over. A pending invitation to the same address was revoked and replaced                                              |
| `201` with the invitation        | The same `requestId` was sent before with the same `email`. Nothing changed, and the answer is the same (FR-AU-89 (a)); the invitation is returned as it now stands |
| `409` with code `account_exists` | The `requestId` is new and the address already belongs to an account; nothing was created                                                                           |
| `422`                            | The body is not as above, the address is not an email address, or the `requestId` was sent before with another `email`                                              |

**List.** `GET /api/admission/invitations`

`200` with `{ "invitations": [ … ] }`: every invitation, in one answer, without pages.

**Revoke.** `DELETE /api/admission/invitations/<id>`

| Answer                        | When                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `200` with the invitation     | A pending invitation was revoked, or the invitation was revoked already, so a retry succeeds |
| `404`                         | No invitation has that identifier                                                            |
| `409` with code `not_pending` | The invitation is accepted or expired                                                        |

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

### Two worked examples

With the secret `test-secret-not-for-use`, which is too short to be accepted as a real one and exists only for these two vectors, and the time `1791450000` (8 October 2026, 09:00:00 UTC):

| Request                                                                                                                                     | `X-Ekdotico-Signature`                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/admission/invitations`, no body. The message is `1791450000\nGET\n/api/admission/invitations\n`                                   | `8a14f444fff88dc5961c8afc1f69397a5e75cb8de2e7276175f2952e0a2cb028` |
| `POST /api/admission/invitations` with the 81-byte body `{"email":"person@example.com","requestId":"0b9f6c1e-5d1c-4a55-9d53-1f3a2f6f7a10"}` | `ab17fe9356e656b887bfaf8e854a15ac2ce5af5fc262764c0cfaab6965f45f30` |

Both values were computed twice, independently. The tests of `src/lib/admission/signature.ts` hold them, so that a second implementation can check itself against this page.

## The row for the register

In the columns of the register's table of other questions; the identifier is the register's to assign. The owner's decision of 8 October 2026 also wants a row among the decisions.

| ID  | What is open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Where                                                                    | Recommendation, if any                                                                                                                                                                                                                                                                                                                                | Who decides                                    | α 0.1.0                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| —   | **The wire format of the admission signature.** FR-AU-89 fixes the algorithm, what is signed, and the 5 minutes. It gives no header names, no encoding, no signed string, no setting name for the secret, and no status code or body shape for any outcome. The owner's decision of 8 October 2026: the format belongs to Praktico's specification; until that states one, the application builds the format recorded in `docs/contracts/admission-signature.md` of the `ekdotico` repository, as provisional | FR-AU-89, FR-AU-57; API design, "Admission"; NFR-SE-05 (b); register Q25 | Praktico's specification adopts the recorded format as it stands, since the application and its command already speak it. The alternatives: Praktico's specification states another format, and the application's one module is rewritten to it; or HTTP Message Signatures (RFC 9421), which does not map exactly onto the four parts FR-AU-89 names | The owner, with Praktico's specification (Q25) | In the release, as recorded and provisional |
