# Ekdotico — Agent Rules

Loaded into every Claude Code session in this repository. Project rules override global defaults.

Brought up to date on 7 October 2026 against Docs commit `f4ec614` (register row Q26; decisions D34 and D83 to D121).

## Scope

This repository is the Ekdotico **application**. **Istorico is out of scope**: do not build FR-PR, FR-VR, the signer host, the reconciler, the key registry, anchoring, the record bundle, or `verify.ekdoti.co`. They live in `Ekdotico/istorico`, which has its own owner and rules.

The application meets Istorico only through the **integration contract** (`app/(site)/design/integration-contract/page.mdx` in the Docs; NFR-IC-15). Build the seam as a **port** with a no-op adapter, exactly as clause IC-49 defines it for α 0.1.0; IC-18 lists what α builds and what it leaves to the release that links Istorico, and IC-50 names the extension points it leaves. Never stub Istorico's internals, and never invent a signed payload.

**The repository depends on no package of Istorico's (D83).** It carries its own copy of the α subset of the port, with the no-op adapter and its tests, behind an interface. When Istorico publishes `@ekdotico/istorico-contract`, adopting it deletes the copy and changes no call; keep the copy shaped so that this stays true. Every document is unrecorded and carries the mark "Not recorded" (FR-ED-43). Nothing else of provenance is built: no recorder, no transaction tagging, no registration, no erasure call.

## Releases

0.1.x is alpha (α), a Closed α; 0.2.x is beta; 1.0 is the first public release. **α 0.1.0 is defined by requirement ID** on `app/(site)/implementation/build-phases/page.mdx`, with its exclusions and entry criteria: 73 functional requirements (16 in part) and 44 non-functional release criteria (18 in part). A requirement not listed there is not in α 0.1.0, however small, and a requirement listed "in part" is in only for the part stated.

α 0.1.0 is used by the founding team alone. The Feedback Widget and the admission of test users from a screen in Praktico are built later in the 0.1.x line (D84); the release sends nothing to Praktico and waits on nothing from Praktico or Istorico.

- Node.js 26 only (NFR-IC-03). Every dependency is pinned to an exact version, with no `^` or `~` range (NFR-IC-08), and is installed at its latest stable release unless a constraint is recorded (NFR-IC-04). The licence is `AGPL-3.0-only` (NFR-IC-12).
- Release-please manages versions; the first release is 0.1.0. Do not merge the Release PR.

## Identity: Better Auth

Identity is Better Auth, a library inside the application (D34), pinned exactly (NFR-IC-20), with its tables in the `ekdotico` schema. There is no identity processor and no webhook. Clerk is not used anywhere.

- **Email address and password only** (D85). No OAuth, SSO, SCIM, or magic-link plugin. The one exception is the sign-in link in the email of a lock (D115; A104, assumed), which is the application's own code and not a plugin.
- **Public sign-up is off** (NFR-SE-17). An account is created only from an admission invitation (FR-AU-57, FR-AU-89, FR-AU-90), through three signed admission endpoints: create, list, revoke (D110). They are called by a command kept in this repository, which signs the requests, writes no invitation itself, and prints neither the token nor the link (D113). There is no admission screen here; Praktico's comes later.
- **Two-factor authentication** is optional, and required of the accounts whose address is in `FOUNDING_TEAM_EMAILS` (D87, D114). Such an account reaches no page, no API route, and no collaboration handshake until it is on, and cannot turn it off.
- **The session cookie cache is on for 1 minute** (D97, D116). Only a request that reads may use it. Every request that changes state, the draft export, and the issue of an image link read the session's row. The collaboration server never uses the cache.

## Settings and names fixed by the specification

| Name | What it is | Source |
|---|---|---|
| `FOUNDING_TEAM_EMAILS` | The founding team's addresses, separated by commas. Set in the environment of the web application and of the collaboration server; a process refuses to start where it is absent, and an empty list is written as an empty value. Read at start, compared without regard to case, never taken from a request, never held in the database | D114; A102 (assumed) |
| `FEEDBACK_INTAKE_ENABLED` | The switch for step (c) of an account deletion (FR-AU-58). **Off in α 0.1.0.** See the next section | D112 |
| `ekdotico_backup` | The database role under which the copy of the backups kept outside DigitalOcean is dumped. Select on the `ekdotico` schema and nothing else. One of the schema's three roles, all created by the provisioning script, which an administrator runs and which is not a migration (contract IC-51) | D118; A28 (name and privileges assumed) |

## The Feedback Widget and `FEEDBACK_INTAKE_ENABLED`

The Feedback Widget (FR-AU-59 to FR-AU-80) is **not** in α 0.1.0 (D84). Build none of it, and no feedback secret, feedback limit, or call to Praktico.

Step (c) of an account deletion, which instructs the feedback intake, **is** built in α 0.1.0, with its tests, behind the switch `FEEDBACK_INTAKE_ENABLED`, which is off (D112). With the switch off the step makes no call. The switch is read in one place, the account-deletion step; when that code exists, name its file here.

**Standing reminder.** When work on the Feedback Widget begins, in any session, tell the owner before doing anything else that `FEEDBACK_INTAKE_ENABLED` must be switched on in the release that adds the widget. The owner asked for this reminder (D112, Q26). With the widget also return: the last sentence of the Closed α notice (FR-AU-55, D111), the feedback secret (NFR-SE-17), and the feedback limits (NFR-SE-07).

## Services and infrastructure

- **User interface** is built from `@ekdotico/domico` 0.25.0 or later (GitHub Packages). Read the package's `AGENTS.md` and its docs in `node_modules` before any UI work. If a control or a token is missing, stop and report; do not improvise one here.
- **Email** is sent through Scaleway Transactional Email, behind an interface with a local sink. Send no real email until the owner confirms the checks of the service (register A52, A72).
- **Production** is DigitalOcean Frankfurt (PostgreSQL, Valkey, Spaces). Provisioning it and setting its secrets are the owner's tasks. Develop against local equivalents. Never deploy, and never commit a secret.
- No job queue, no AI provider, no product analytics, and no error-reporting service that receives personal data (NFR-DP-05). Scheduled work runs on timers in the application and in the collaboration server (NFR-RE-15).

## The specification is the source of truth

[`Ekdotico/docs`](https://github.com/Ekdotico/docs), branch `main`, is the only source of requirements. Every behaviour, field, wording, time, and limit comes from it; general knowledge and common practice do not.

- **Read `origin/main`, not the working tree.** The local `../docs` checkout may be on a feature branch far behind main. Run `git -C ../docs fetch origin`, then `git -C ../docs show origin/main:<path>`. Record the commit with `git -C ../docs rev-parse --short origin/main` and cite it in commit messages.
- Treat `../docs` as read-only. Never edit, branch, or commit there from this repository. Touch no other repository either.
- Where the locked stack (NFR-IC-01) allows a choice, or a detail is internal (file layout, function names, test structure), the decision is yours. A choice becomes a gap when it changes observable behaviour, stored data, a displayed word, a threshold, or a security or data-protection property that the Docs do not settle.
- The design pages live under `app/(site)/` in the Docs. The SRS files under `srs/` are normative; the integration contract is normative for the boundary with Istorico; the other design pages follow the SRS and never override it. Where a page and an SRS file disagree, the SRS file governs; report the disagreement.
- **The open questions register** (`app/(site)/implementation/open-questions/page.mdx`) is the one place that says whether something is settled. Its introduction says how to read what is open. Check it before building anything that touches a marked item:
  - **Not decided** (N, P, Q, R, and L rows): not implemented in any form, including behind a flag or as a placeholder. If the task needs one, stop.
  - **Assumed, confirm** (A rows that are still open): the text is written as fact so that nothing is undefined, and it may change when the person named confirms it. Implement it as written, keep it isolated so that it is cheap to change, and name the A row in the commit message and in the pull request that builds on it.
  - **Decided** (D rows): binding.
  - A row marked "Issue" must be closed before the release or the event it names; do not work past it.
- Items the Docs mark "initial value" or "proposal" are parameters: make them configurable, defaulting to the stated value. A value "to be set" has no default: stop.
- Fixed texts quoted in a requirement are used verbatim.

### When the Docs are missing, ambiguous, contradictory, or wrong: stop

Do not guess, stub, or "fill the gap", and do not build a Not decided row behind a flag. Stop on that item and tell the owner in the conversation. Since `../docs` is read-only from here, write the question as a ready-made register row for the owner to add: what is open, a recommended answer, up to three alternatives, who decides, and whether it blocks α 0.1.0. Continue only with work that does not depend on the answer.

## Process

- Feature branches and pull requests for everything; never commit to `main` directly. Small vertical slices, each leaving `main` deployable. Conventional commits, citing requirement IDs and the Docs commit: `feat(editor): slash palette (FR-ED-10 to FR-ED-12; docs@f4ec614)`.
- Verify before claiming done: run the build, typecheck, lint, and tests, and report the real output. Say plainly what was not tested.
- Security-sensitive code (sessions, tokens, signatures, rate limits, the origin check, uploads, the zip export, authorisation on every request) gets tests that fail when the rule is broken, and an independent review before merge.
- The accessibility target is WCAG 2.2 Level AA (NFR-IC-19).
- Do not auto-commit while the owner is reviewing as they go. Do not merge or deploy unless asked.
- UI copy follows the Expression Guidelines in `@ekdotico/domico`; British spelling; the controlled vocabulary names one term per concept ("research workspace assistant", "Task tracker", "planning canvas", "auto-add", "enrolment").
