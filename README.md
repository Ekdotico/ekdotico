# Ekdotico

Ekdotico is a browser-based academic writing platform: a collaborative block editor with LaTeX and Mermaid blocks, a planning canvas, a research workspace, a PDF reader, a citation engine and bibliography manager, five AI tools on Anthropic's Claude models, and an export pipeline.

This repository is the application. It does **not** contain Istorico, the Ekdotico provenance system (recording, signing, and `verify.ekdoti.co`), which is [`Ekdotico/istorico`](https://github.com/Ekdotico/istorico). The application meets Istorico only through a port, which the integration contract in the Docs defines.

**Status:** pre-launch. Most of the features of α 0.1.0 are built: admission and sign-in, documents and their sharing, the collaborative editor with images, the draft export, and the deletion of documents and of accounts. The slices still open are listed in the build handoff, and nothing is deployed.

## Specification

The specification is [`Ekdotico/docs`](https://github.com/Ekdotico/docs), branch `main`. Nothing here is built that it does not specify. Read it from `origin/main`, not from whatever branch a local checkout happens to be on:

```bash
git -C ../docs fetch origin
```

```bash
git -C ../docs show origin/main:srs/2-functional-requirements/2.2.06-fr-ed.md
```

The working rules are in [`CLAUDE.md`](CLAUDE.md), and the decision records in [`docs/decisions`](docs/decisions).

One interface is defined here and not in the specification, provisionally: the wire format of the signed admission requests, in [`docs/contracts/admission-signature.md`](docs/contracts/admission-signature.md). It belongs to Praktico and is replaced when Praktico's specification states one.

## Requirements

- Node.js 26 (`.nvmrc`), and pnpm 10.
- `psql`, the PostgreSQL client, for the provisioning script and its test.
- A GitHub token that can read packages, to install `@ekdotico/domico` (see Installing).

## Installing

`@ekdotico/domico` is on GitHub's package registry, which asks for a token even for a public package. Make a classic personal access token with only the `read:packages` scope, and put it in your environment as `NODE_AUTH_TOKEN`; never write its value into a file. pnpm takes a registry credential only from your own `~/.npmrc`, never from the one in this repository, so put this line there once. It names the variable and holds no token:

```
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then, in a shell where `NODE_AUTH_TOKEN` is set:

```bash
pnpm install
```

## Local services

Development runs against local equivalents of the production services. Production is DigitalOcean in AMS3 (register D313) and is provisioned by the owner.

Start PostgreSQL 17, Valkey, and the local object store of the images (SeaweedFS, a store of the S3 protocol; production is DigitalOcean Spaces, which the owner provisions):

```bash
docker compose up -d
```

The images need a bucket on that store, and the settings that name it (`.env.example`; the keys are the ones in `docker/object-store-s3.json`, which open that store and nothing else). Without the settings the application stores no image and says so. Make the bucket once, with the settings in the environment of the shell:

```bash
IMAGE_STORAGE_ENDPOINT=http://localhost:8333 IMAGE_STORAGE_BUCKET=ekdotico-images IMAGE_STORAGE_ACCESS_KEY_ID=ekdotico-dev-access IMAGE_STORAGE_SECRET_ACCESS_KEY=ekdotico-dev-secret-key-0000000000 node scripts/create-bucket.ts
```

A PostgreSQL 17 server that is already running on the machine serves as well. Create the database on it, UTF8 with the `en_US.UTF-8` locale, which the provisioning script requires (NFR-I18-03), and use that server's superuser connection in place of the one below:

```bash
psql postgres -c "CREATE DATABASE ekdotico ENCODING 'UTF8' LOCALE 'en_US.UTF-8' LOCALE_PROVIDER libc TEMPLATE template0"
```

Copy the settings of the two processes. `pnpm dev`, `pnpm start` and `pnpm dev:collab` read `.env.local`; everything else, `pnpm start:collab` included, takes its settings from the environment or the command line, as shown below:

```bash
cp .env.example .env.local
node scripts/dev-secret.mjs .env.local
```

The second line fills `AUTH_SECRET` with a fresh random value, which it does not print.

Create the `ekdotico` schema and its three roles. The script is run by an administrator and is not a migration (contract IC-51). The passwords here are for a development machine only:

```bash
psql "postgresql://postgres:postgres@localhost:5432/ekdotico" -v migrate_password=local-migrate -v app_password=local-app -v backup_password=local-backup -f scripts/provision.sql
```

Deploy the migrations, as the migration role:

```bash
MIGRATE_DATABASE_URL="postgresql://ekdotico_migrate:local-migrate@localhost:5432/ekdotico?schema=ekdotico" pnpm db:migrate
```

## The two processes

The web application, on port 3000:

```bash
pnpm dev
```

The collaboration server, on port 1234:

```bash
pnpm dev:collab
```

Every response of the web application carries a Content-Security-Policy and the headers beside it, set by the application itself (`src/lib/csp.ts`; [`docs/operations/deployment.md`](docs/operations/deployment.md) states the policy). `pnpm dev` runs under the policy with the two allowances the development server of Next.js needs (`'unsafe-eval'` for scripts, and `<style>` elements without a nonce); `pnpm build` and `pnpm start` run under the policy a deployment has, and the end-to-end tests fail where a page does anything it refuses. A script written into a page needs the nonce of the request (`src/app/layout.tsx` shows how), and an image, a font or a request of another origin is refused.

Each refuses to start where one of the five settings of `.env.example` is absent; for `FOUNDING_TEAM_EMAILS` an empty value is a list with no address. The collaboration server reads no file by itself, so `pnpm dev:collab` hands it the same one (`node --env-file=.env.local`) and fails where the file is missing; `COLLAB_PORT` names another port. Their health checks are `GET /api/health` and `GET /collab/health`, which answer 200 with an empty body.

The collaboration server accepts a WebSocket at `/collab` only from a request whose `Origin` header is `APP_ORIGIN` and whose cookie is a session of the application. A browser sends that cookie only to the application's own origin, so a page reaches the collaboration server through a reverse proxy that serves both processes on one origin ([`docs/operations/deployment.md`](docs/operations/deployment.md)). On a development machine the web application does that itself: with `COLLAB_PROXY_TARGET=http://127.0.0.1:1234` in `.env.local` (the line is in `.env.example`, commented out), `pnpm dev` and `pnpm start` pass `/collab`, the WebSocket upgrade included, to the collaboration server, with the `Origin` and `Cookie` headers as the browser sent them. The collaboration server checks both exactly as it does in production. It is read when the application is built, and the build holds the rewrite from then on, so `pnpm build` needs it as `pnpm start` does. Two checks keep it on a development machine. The build is refused unless `APP_ORIGIN` and the target are both on localhost (`next.config.ts`). The start is refused where `APP_ORIGIN` is not on localhost and either the setting is present or the build that is being started holds the rewrite (`src/lib/settings.ts`; the second is read from `.next/routes-manifest.json` in the working directory, and the target is not looked at). A deployment leaves the setting unset when it builds and when it starts, and uses its reverse proxy. Open the application at the address `APP_ORIGIN` names and at no other writing of it (`localhost` is not `127.0.0.1` to the origin check). On `SIGTERM` or `SIGINT` the server stores every open document and then exits; a second signal exits at once.

## Checks

| Command                 | What it checks                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:deps`       | Every dependency pinned exactly, every licence admitted (NFR-IC-08, NFR-IC-12)                                                                                                                                                                                                                              |
| `pnpm format`           | Formatting                                                                                                                                                                                                                                                                                                  |
| `pnpm lint`             | Lint                                                                                                                                                                                                                                                                                                        |
| `pnpm typecheck`        | Types                                                                                                                                                                                                                                                                                                       |
| `pnpm test`             | Unit tests                                                                                                                                                                                                                                                                                                  |
| `pnpm test:integration` | Provisioning, migrations, identity, sessions, the proxy, the limits, the security log, documents, and the collaboration server as a process of its own, against a real PostgreSQL server and a real Valkey. Needs `ADMIN_DATABASE_URL`, a superuser connection, and `VALKEY_URL`                            |
| `pnpm build`            | The production build                                                                                                                                                                                                                                                                                        |
| `pnpm test:e2e`         | The end-to-end tests, on a production build that the run makes itself. The tests of the editor and of the images start a collaboration server of their own, on the port after the application's, one file after the other (`playwright.config.ts`). Needs PostgreSQL and Valkey as the integration tests do |

The tests of the adapter of the object store (`tests/integration/image-store.test.ts`) and of the images in the browser (`tests/e2e/images.spec.ts`) run where the four settings of the object store are in the environment, and are skipped, with a line that says so, where they are not. Each run of the first makes a bucket of its own and deletes it.

The integration test runs only against a local server. It creates databases of its own and drops them. The three roles belong to the server, so they stay, with the development passwords above.

The end-to-end tests need Playwright's browser once:

```bash
pnpm exec playwright install chromium
```

They build the application and serve it on port 3000. Where `pnpm dev` holds that port, `E2E_PORT` names another, and with `ADMIN_DATABASE_URL` the run makes a database of its own and leaves the development database alone:

```bash
ADMIN_DATABASE_URL=postgresql://localhost:5432/postgres E2E_PORT=3109 pnpm test:e2e
```

CI runs all of them on every pull request, on Node.js 26.

## Contributing

Until the beta, Ekdotico is built by a small founding team, and we are not accepting pull requests from outside the team. Issues are very welcome: if you find a bug or have an idea, please open one. We will say here when that changes.

## Licence

The code is licensed under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`); see [LICENSE](LICENSE). [NOTICE](NOTICE) names the copyright holder. The Ekdotico name and marks are not licensed; see [TRADEMARKS.md](TRADEMARKS.md).

## Records and procedures the release carries

The match of every table, column, object prefix, Valkey key family, timer and file to a row of §2.7 ([`docs/records/storage-match.md`](docs/records/storage-match.md)), the processors ([`docs/records/processors.md`](docs/records/processors.md)), the 14 days for security patches ([`docs/records/dependency-patches.md`](docs/records/dependency-patches.md)), the six procedures that show the release criteria ([`docs/procedures`](docs/procedures/README.md); `node scripts/record.ts new <procedure> <release>` makes the record of a run), the rotation of the secrets ([`docs/operations/secret-rotation.md`](docs/operations/secret-rotation.md)) and the copy of the backups outside DigitalOcean ([`docs/operations/backup.md`](docs/operations/backup.md); `scripts/backup.ts`, `scripts/backup-restore.ts`). The reference document of NFR-IC-14 is `tests/fixtures/reference-document.json` and its harness is `scripts/measure-editor.ts`. The test of the copy needs `pg_dump` of the server's major version or later (`brew install postgresql@17`).
