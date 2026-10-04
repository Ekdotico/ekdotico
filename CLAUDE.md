# Ekdotico — Agent Rules

Loaded into every Claude Code session in this repository. Project rules override global defaults.

## Scope

This repository is the Ekdotico **application**. **Istorico is out of scope**: do not build FR-PR, FR-VR, the signer host, the reconciler, the key registry, anchoring, the record bundle, or `verify.ekdoti.co`. They live in `Ekdotico/istorico`, which has its own owner and rules.

The application meets Istorico only through the **integration contract** (`app/(site)/design/integration-contract/page.mdx` in the Docs; NFR-IC-15). Build the seam as a **port** with a no-op adapter, exactly as clause IC-49 defines it for α 0.1.0; IC-18 lists what α builds and what it leaves to the release that links Istorico. Never stub Istorico's internals, and never invent a signed payload. `analysis/srs-analysis.md` is history: it was written against SRS 1.5.0, before the contract existed, and binds nothing.

## Releases

0.1.x is alpha (α), 0.2.x is beta, 1.0 is the first public release. **α 0.1.0 is defined by requirement ID** on `app/(site)/implementation/build-phases/page.mdx`, with its exclusions and entry criteria. A requirement not listed there is not in α 0.1.0, however small. The application runs on Node.js 26 only (NFR-IC-03).

## The specification is the source of truth

[`Ekdotico/docs`](https://github.com/Ekdotico/docs), branch `main`, is the only source of requirements. Every behaviour, field, wording, time, and limit comes from it; general knowledge and common practice do not.

- **Read `origin/main`, not the working tree.** The local `../docs` checkout may be on a feature branch far behind main. Run `git -C ../docs fetch origin`, then `git -C ../docs show origin/main:<path>`. Record the commit with `git -C ../docs rev-parse --short origin/main` and cite it in commit messages.
- Treat `../docs` as read-only. Never edit, branch, or commit there from this repository.
- Where the locked stack (NFR-IC-01) allows a choice, or a detail is internal (file layout, function names, test structure), the decision is yours. A choice becomes a gap when it changes observable behaviour, stored data, a displayed word, a threshold, or a security or data-protection property that the Docs do not settle.
- The design pages live under `app/(site)/` in the Docs. The SRS files under `srs/` are normative; the integration contract is normative for the boundary with Istorico; the other design pages follow the SRS and never override it.
- **The open questions register** (`app/(site)/implementation/open-questions/page.mdx`) is the one place that says whether something is settled. Check it before building anything that touches a marked item:
  - **Not decided** (N, P, Q, R, and L rows): not implemented in any form, including behind a flag or as a placeholder. If the task needs one, stop.
  - **Assumed, confirm** (A rows): the text is written as fact so that nothing is undefined, and it may change when the person named confirms it. Implement it as written, keep it isolated so that it is cheap to change, and name the A row in the commit message.
  - **Decided** (D rows): binding.
  - A row marked "Issue" must be closed before the release or the event it names; do not work past it.
- Items the Docs mark "initial value" or "proposal" are parameters: make them configurable, defaulting to the stated value. A value "to be set" has no default: stop.

### When the Docs are missing, ambiguous, contradictory, or wrong: stop

Do not guess, stub, or "fill the gap". Tell the owner in the conversation and write `docs-amendment-requests/NNNN-short-slug.md` (same format as Istorico: Raised, Docs commit, Status, Requirement(s), Type, What the Docs say, The issue, Why an amendment is required, Recommendations to amend with draft text and an amendment note, What is blocked and what can continue). Continue only with work that does not depend on the answer.

## Process

- Feature branches, one concern each; no commits to `main` beyond trivial fixes. Conventional commits, citing requirement IDs and the Docs commit: `feat(editor): slash palette (FR-ED-10 to FR-ED-12; docs@37c5e8c)`.
- Verify before claiming done: run typecheck, lint, and tests, and report the real output.
- Do not auto-commit while the owner is reviewing as they go. Do not merge or deploy unless asked.
- UI copy follows the Expression Guidelines in `@ekdotico/domico`; British spelling; the controlled vocabulary names one term per concept ("research workspace assistant", "Task tracker", "planning canvas", "auto-add", "enrolment").
