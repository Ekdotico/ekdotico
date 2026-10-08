# What a deployment must do

Provisioning the production services and setting their secrets are the owner's tasks. This page lists what the application's code relies on a deployment to do. Each item is something the code cannot do for itself; a deployment that leaves one out is less safe than the tests show. The page is reviewed on each deployment, with the allow-list of `src/proxy.ts` (NFR-SE-05).

## A reverse proxy stands in front of each process

1. **The web application is reachable only through the proxy.** With `TRUSTED_PROXY_COUNT` set to the number of proxies, the application takes a client's network address from the entry of `X-Forwarded-For` that the outermost of them wrote. A client that reaches the process directly writes that entry itself.
2. **`TRUSTED_PROXY_COUNT` is 1 or more.** Next.js 16.4.0 gives `proxy.ts` no address it can trust without a proxy (`next/dist/server/base-server.js`: the header is filled from the socket only where the request carried none). With 0, which is the initial value, every request without a session shares one count of NFR-SE-07, and one client can use it up for everyone. That is acceptable on a development machine and nowhere else.
3. **The proxy appends the address of its peer** to `X-Forwarded-For`, or overwrites the header with it, as a bare IPv4 or IPv6 address. An entry written with a port, or in brackets, is not read as an address, and such requests share the one count.
4. **The proxy removes the header `x-prerender-revalidate` from every request.** Next.js does not pass a request through `proxy.ts` where this header holds the identifier of the build (`next/dist/server/next-server.js`, `runMiddleware`). The identifier is written into the build output (`.next/prerender-manifest.json`). A request that carried it would meet no session check, no origin check, and no limit at the proxy. Each route handler validates the session itself as well (`tests/unit/routes.test.ts`), so such a request to a route handler is still refused where it needs a session; the origin check and the limits are what it would escape. That covers route handlers and not pages: a page under the signed-in layout checks the session in its layout from the next slice on, and until then the application's one page shows nothing of an account.
5. **The proxy serves the collaboration server on the application's own origin**, under `/collab`, since the session cookie is host-only (NFR-SE-17 (c)). It sends `/collab` and `/collab/health`, and no other path, to the collaboration server process, and everything else to the web application.
6. **The proxy passes the WebSocket upgrade through** on `/collab`: the `Upgrade` and `Connection` headers, HTTP/1.1 to the process, and the `Origin` and `Cookie` headers exactly as the browser sent them. The collaboration server refuses a handshake whose `Origin` is not `APP_ORIGIN`, character for character, before it reads the cookie (FR-AU-08); a proxy that rewrites or drops `Origin` makes every handshake a 403.
7. **The proxy does not close an idle WebSocket in under a minute.** The server itself ends a connection from which it has received nothing for 60 seconds, and pings each one every 30.
8. **The collaboration server is reachable only through the proxy**, as the web application is (item 1). The header rules of this section apply to it unchanged; it reads no network address, and so no `X-Forwarded-For`.

## The collaboration server

It is a process of its own, `pnpm start:collab`, with the same settings as the web application: both read `src/lib/settings.ts`, and `FOUNDING_TEAM_EMAILS`, `APP_ORIGIN`, `DATABASE_URL`, `VALKEY_URL` and `AUTH_SECRET` must be the same for the two, or a session of one is no session of the other (NFR-SE-17 (f)). `COLLAB_PORT` is the port it listens on, 1234 where unset.

**A deployment stops it with `SIGTERM` and waits for it to exit.** On `SIGTERM` or `SIGINT` it accepts no further handshake, stores every open document, and exits with 0; it exits with 1 where a document could not be stored after three attempts, and at once on a second signal (NFR-RE-07). A process that is killed stores nothing: what it had received in the 2 seconds before (`COLLAB_STORE_DELAY_MS`), or in the 10 seconds before while changes kept arriving (`COLLAB_STORE_MAX_MS`), is held only by the browsers that sent it, which send it again when they reconnect.

**One instance only, for now.** Two instances do not yet share a document: each would hold its own copy and store over the other's (NFR-SC-04 is not built). And a connection that was accepted stays open until its browser closes it: the server does not yet end it when the session ends or when the account loses its role (of NFR-SE-03 (b) to (e), only the deletion of a document is built). Both are later slices of the plan.

**It hears of a deleted document over Valkey, and listens only once it does.** The web application publishes the deletion of a document on a Valkey channel, and every collaboration server instance closes its connections to that document at once (FR-ED-40 (c), NFR-SE-03 (d); `src/lib/collab/events.ts`). So the two processes must share one Valkey, and a collaboration server that cannot reach it at start does not open its port, and its health check does not answer, until it can. A notice that is lost, because Valkey was away for a moment, leaves a connection open: the re-check that closes it within 60 seconds (FR-ED-41) is a later slice.

## Deleted documents

A deleted document is kept for `DELETED_DOCUMENT_RETENTION_DAYS`, 30 where unset, and is then deleted permanently, with its state, by a timer in the web application that runs at start and each hour (FR-ED-36, NFR-RE-15). Any number of instances may run it: each document is claimed by one of them. A line `permanent deletion: document kept (…)` on stderr names a document that could not be deleted in that run and is tried again in the next.

## The build output is kept as a secret is

The `.next` directory holds the identifier of item 4. A container image, a build artefact, and a host that hold it are readable only by those who may deploy. Draft mode is never used, since it sends the same identifier to the browser as a cookie; the lint rule in `eslint.config.mjs` refuses its import.

## Settings

A process refuses to start without `FOUNDING_TEAM_EMAILS`, `APP_ORIGIN`, `DATABASE_URL`, `VALKEY_URL`, and `AUTH_SECRET`, and, away from a development machine, without `EMAIL_TRANSPORT` and `EMAIL_SINK_DIRECTORY`. `.env.example` describes each. No variable whose name begins `BETTER_AUTH_` may be set: the identity library reads several of its own, which would change its configuration, and each of the two processes refuses to start where one is present. A variable whose name begins `RATE_LIMIT_` and names no limit stops a process in the same way, as does a period or a length that is 0 or out of order.

`EMAIL_SINK_DIRECTORY` names the directory the email sink writes to. Each file in it holds an address and may hold a single-use link, so a deployment says where they go: only on a development machine is a directory under the working directory used where the setting is absent.

The database client gives up on a connection after 5 seconds, the server ends a statement after 5 seconds, and the client stops waiting for an answer after 5 seconds (`src/lib/db.ts`; NFR-SE-06). A connection to Valkey and a command sent to it are given 5 seconds each (`src/lib/valkey.ts`). A request that meets either fault is refused and never passed on.

Changing `AUTH_SECRET` ends every session and forgets every count of NFR-SE-07, since the counters are stored under digests keyed by it. The procedure for rotating each secret is recorded before the first test user is admitted (NFR-SE-17 (e)); it is not yet written.

## The password list

`PASSWORD_LIST_FILE` names the list of commonly used and known-compromised passwords (FR-AU-82), by default `data/common-passwords.txt` under the directory the process is started in. The file ships with the deployment. Where it cannot be read, or holds no entry, every request that sets a password fails, so that none is set unchecked. **The file in the repository is a placeholder of a few dozen entries** and is replaced before a test user is admitted; which list replaces it is the owner's decision (register A66, D86).

## Email

The only sender built so far writes each message to a file and sends nothing (register D70 (the three checks stand), D92). A deployment that sets `EMAIL_TRANSPORT=sink` sends no invitation, no reset link, and no notice.
