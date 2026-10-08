# What a deployment must do

Provisioning the production services and setting their secrets are the owner's tasks. This page lists what the application's code relies on a deployment to do. Each item is something the code cannot do for itself; a deployment that leaves one out is less safe than the tests show. The page is reviewed on each deployment, with the allow-list of `src/proxy.ts` (NFR-SE-05).

## A reverse proxy stands in front of each process

1. **The web application is reachable only through the proxy.** With `TRUSTED_PROXY_COUNT` set to the number of proxies, the application takes a client's network address from the entry of `X-Forwarded-For` that the outermost of them wrote. A client that reaches the process directly writes that entry itself.
2. **`TRUSTED_PROXY_COUNT` is 1 or more, and a process refuses to start otherwise** wherever `APP_ORIGIN` is not on localhost (the owner's decision of 8 October 2026). The count is the number of proxies between a client and the process, each of which adds one entry to `X-Forwarded-For`: with 1 the application reads the last entry, with 2 the last but one, and so on, so that it reads the entry the outermost proxy wrote and never one a client wrote. A count that is too high reads an entry the client wrote, and lets a client choose its own address; one that is too low reads the address of an inner proxy, and every client shares its count. Next.js 16.4.0 gives `proxy.ts` no address it can trust without a proxy (`next/dist/server/base-server.js`: the header is filled from the socket only where the request carried none). With 0, which is the initial value on localhost and is admitted nowhere else, every request without a session shares one count of NFR-SE-07, and one client can use it up for everyone.
3. **The outermost proxy overwrites `X-Forwarded-For` with the address of its peer**, and each proxy behind it appends the address of its own peer, as a bare IPv4 or IPv6 address. Where there is one proxy it overwrites the header. A proxy that only appends is safe too, as long as the count is exact, since the entries a client wrote stand to the left of those that are read. An entry written with a port, or in brackets, is not read as an address, and such requests share the one count. The setting cannot show that the proxy exists: a process that starts with a count of 1 and is reached directly takes whatever address the client writes.
4. **The proxy removes the header `x-prerender-revalidate` from every request.** Next.js does not pass a request through `proxy.ts` where this header holds the identifier of the build (`next/dist/server/next-server.js`, `runMiddleware`). The identifier is written into the build output (`.next/prerender-manifest.json`). A request that carried it would meet no session check, no origin check, and no limit at the proxy. Each route handler validates the session itself as well (`tests/unit/routes.test.ts`), so such a request to a route handler is still refused where it needs a session; the origin check and the limits are what it would escape. That covers route handlers and not pages: a page under the signed-in layout checks the session in its layout from the next slice on, and until then the application's one page shows nothing of an account.
5. **The proxy serves the collaboration server on the application's own origin**, under `/collab`, since the session cookie is host-only (NFR-SE-17 (c)).

## The build output is kept as a secret is

The `.next` directory holds the identifier of item 4. A container image, a build artefact, and a host that hold it are readable only by those who may deploy. Draft mode is never used, since it sends the same identifier to the browser as a cookie; the lint rule in `eslint.config.mjs` refuses its import.

## Settings

A process refuses to start without `FOUNDING_TEAM_EMAILS`, `APP_ORIGIN`, `DATABASE_URL`, `VALKEY_URL`, and `AUTH_SECRET`, and, away from a development machine, without `EMAIL_TRANSPORT`, `EMAIL_SINK_DIRECTORY`, and a `TRUSTED_PROXY_COUNT` of 1 or more. `.env.example` describes each. No variable whose name begins `BETTER_AUTH_` may be set: the identity library reads several of its own, which would change its configuration, and each of the two processes refuses to start where one is present. A variable whose name begins `RATE_LIMIT_` and names no limit stops a process in the same way, as does a period or a length that is 0 or out of order.

`EMAIL_SINK_DIRECTORY` names the directory the email sink writes to. Each file in it holds an address and may hold a single-use link, so a deployment says where they go: only on a development machine is a directory under the working directory used where the setting is absent.

The database client gives up on a connection after 5 seconds, the server ends a statement after 5 seconds, and the client stops waiting for an answer after 5 seconds (`src/lib/db.ts`; NFR-SE-06). A connection to Valkey and a command sent to it are given 5 seconds each (`src/lib/valkey.ts`). A request that meets either fault is refused and never passed on.

Changing `AUTH_SECRET` ends every session and forgets every count of NFR-SE-07, since the counters are stored under digests keyed by it. The procedure for rotating each secret is recorded before the first test user is admitted (NFR-SE-17 (e)); it is not yet written.

## The password list

`PASSWORD_LIST_FILE` names the list of commonly used and known-compromised passwords (FR-AU-82), by default `data/common-passwords.txt` under the directory the process is started in. The file ships with the deployment. Where it cannot be read, or holds no entry, every request that sets a password fails, so that none is set unchecked. The file in the repository is a published list of 476,776 passwords of 8 to 32 characters (the owner's decision of 8 October 2026; register A66, D86); its name, version, source, licence, and filter, and what loading it costs, are in `data/common-passwords.md`. It is read at the first password that is checked, and then holds about 27 MB of memory.

## Email

The only sender built so far writes each message to a file and sends nothing (register D70 (the three checks stand), D92). A deployment that sets `EMAIL_TRANSPORT=sink` sends no invitation, no reset link, and no notice.
