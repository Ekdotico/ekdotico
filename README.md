# Ekdotico

Ekdotico is a browser-based academic writing platform: a collaborative block editor with LaTeX and Mermaid blocks, a planning canvas, a research workspace, a PDF reader, a citation engine and bibliography manager, five AI tools on Anthropic's Claude models, and an export pipeline.

This repository is the application. It does **not** contain Istorico, the Ekdotico provenance system (recording, signing, and `verify.ekdoti.co`), which is [`Ekdotico/istorico`](https://github.com/Ekdotico/istorico). The application emits to Istorico through a port; see [`analysis/srs-analysis.md`](analysis/srs-analysis.md) for the boundary.

**Status:** pre-launch. No application code yet. The repository is private until the first hosted release (NFR-IC-11); the licence is AGPL-3.0.

## Specification

The specification is [`Ekdotico/docs`](https://github.com/Ekdotico/docs), branch `main`. Nothing here is built that it does not specify. Read it from `origin/main`, not from whatever branch a local checkout happens to be on:

```bash
git -C ../docs fetch origin
git -C ../docs show origin/main:srs/2-functional-requirements/2.2.06-fr-ed.md
```

The analysis in this repository was written against Docs commit `37c5e8c` (SRS 1.5.0, 30 September 2026).
