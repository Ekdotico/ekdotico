# Ekdotico

Ekdotico is a browser-based academic writing platform: a collaborative block editor with LaTeX and Mermaid blocks, a planning canvas, a research workspace, a PDF reader, a citation engine and bibliography manager, five AI tools on Anthropic's Claude models, and an export pipeline.

This repository is the application. It does **not** contain Istorico, the Ekdotico provenance system (recording, signing, and `verify.ekdoti.co`), which is [`Ekdotico/istorico`](https://github.com/Ekdotico/istorico). The application meets Istorico only through a port, which the integration contract in the Docs defines.

**Status:** pre-launch. The walking skeleton of α 0.1.0 is in place: the toolchain, the checks, the database provisioning, and a health check for each of the two processes. No feature is built yet. The repository is private until the first hosted release (NFR-IC-11); the licence is `AGPL-3.0-only`.

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
- A token that can read GitHub Packages, to install `@ekdotico/domico`.

pnpm takes a registry credential only from your own `~/.npmrc`, never from the one in this repository. Put this line in `~/.npmrc` once; it names a variable and holds no token:

```
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then pass the token for the one command:

```bash
NODE_AUTH_TOKEN="$(gh auth token)" pnpm install
```

## Local services

Development runs against local equivalents of the production services. Production is DigitalOcean Frankfurt and is provisioned by the owner.

Start PostgreSQL 17 and Valkey:

```bash
docker compose up -d
```

A PostgreSQL 17 server that is already running on the machine serves as well. Create the database on it, UTF8 with the `en_US.UTF-8` locale, which the provisioning script requires (NFR-I18-03), and use that server's superuser connection in place of the one below:

```bash
psql postgres -c "CREATE DATABASE ekdotico ENCODING 'UTF8' LOCALE 'en_US.UTF-8' LOCALE_PROVIDER libc TEMPLATE template0"
```

Copy the settings of the web application. Only `pnpm dev` and `pnpm start` read `.env.local`; everything else takes its settings from the command line, as shown below:

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
node --env-file=.env.local --watch src/collab/server.ts
```

Each refuses to start where one of the five settings of `.env.example` is absent; for `FOUNDING_TEAM_EMAILS` an empty value is a list with no address. The collaboration server reads no file by itself, so the command hands it the same one. Their health checks are `GET /api/health` and `GET /collab/health`, which answer 200 with an empty body.

## Checks

| Command                 | What it checks                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check:deps`       | Every dependency pinned exactly, every licence admitted (NFR-IC-08, NFR-IC-12)                                                                                                                                     |
| `pnpm format`           | Formatting                                                                                                                                                                                                         |
| `pnpm lint`             | Lint                                                                                                                                                                                                               |
| `pnpm typecheck`        | Types                                                                                                                                                                                                              |
| `pnpm test`             | Unit tests                                                                                                                                                                                                         |
| `pnpm test:integration` | Provisioning, migrations, identity, sessions, the proxy, the limits and the security log, against a real PostgreSQL server and a real Valkey. Needs `ADMIN_DATABASE_URL`, a superuser connection, and `VALKEY_URL` |
| `pnpm build`            | The production build                                                                                                                                                                                               |
| `pnpm test:e2e`         | The end-to-end tests, on a production build                                                                                                                                                                        |

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
