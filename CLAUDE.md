# Ekdotico — Agent Rules

Loaded into every Claude Code session in this repository. Project rules override global defaults.

## Scope

This repository is the Ekdotico **application**. **Istorico is out of scope**: do not build FR-PR, FR-VR, the signer host, the reconciler, the key registry, anchoring, the record bundle, or `verify.ekdoti.co`. They live in `Ekdotico/istorico`, which has its own owner and rules.

The application still owes Istorico a seam: signal emission, session lifecycle on the Hocuspocus connection, lock and seal calls, lock-time document facts, and lineage on Revise and Branch. Build the seam as a **port** with a no-op adapter (see `analysis/srs-analysis.md`, section 3). Never stub Istorico's internals, and never invent a signed payload.

## The specification is the source of truth

[`Ekdotico/docs`](https://github.com/Ekdotico/docs), branch `main`, is the only source of requirements. Every behaviour, field, wording, time, and limit comes from it; general knowledge and common practice do not.

- **Read `origin/main`, not the working tree.** The local `../docs` checkout may be on a feature branch far behind main. Run `git -C ../docs fetch origin`, then `git -C ../docs show origin/main:<path>`. Record the commit with `git -C ../docs rev-parse --short origin/main` and cite it in commit messages.
- Treat `../docs` as read-only. Never edit, branch, or commit there from this repository.
- Where the locked stack (NFR-IC-01) allows a choice, or a detail is internal (file layout, function names, test structure), the decision is yours. A choice becomes a gap when it changes observable behaviour, stored data, a displayed word, a threshold, or a security or data-protection property that the Docs do not settle.
- Items the Docs mark "initial value" or "proposal" are parameters: make them configurable, defaulting to the stated value. "Not decided" items (N1 to N13 in `srs/2-functional-requirements/_notes.md`) are not implemented in any form.

### When the Docs are missing, ambiguous, contradictory, or wrong: stop

Do not guess, stub, or "fill the gap". Tell the owner in the conversation and write `docs-amendment-requests/NNNN-short-slug.md` (same format as Istorico: Raised, Docs commit, Status, Requirement(s), Type, What the Docs say, The issue, Why an amendment is required, Recommendations to amend with draft text and an amendment note, What is blocked and what can continue). Continue only with work that does not depend on the answer.

## Process

- Feature branches, one concern each; no commits to `main` beyond trivial fixes. Conventional commits, citing requirement IDs and the Docs commit: `feat(editor): slash palette (FR-ED-10 to FR-ED-12; docs@37c5e8c)`.
- Verify before claiming done: run typecheck, lint, and tests, and report the real output.
- Do not auto-commit while the owner is reviewing as they go. Do not merge or deploy unless asked.
- UI copy follows the Expression Guidelines in `@ekdotico/domico`; British spelling; the controlled vocabulary names one term per concept ("research workspace assistant", "Task tracker", "planning canvas", "auto-add", "enrolment").
