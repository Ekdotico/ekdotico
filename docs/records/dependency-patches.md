# The 14 days for security patches (NFR-IC-10)

Security patches for direct dependencies are applied within 14 days of disclosure, for as long as a 0.1.x release is hosted (build-phases: "the cadence for other updates is not a criterion"). The check is `.github/workflows/advisories.yml` (see `docs/operations/advisories.md`). Each advisory the audit has reported is a row here: the day it was published (`gh api /advisories/<id>`, `published_at`), the day the patch was merged to `main`, and the days between. A row for a direct dependency that passes 14 days is a failure of the rule, and its note says why. A package that arrives only through another is not a direct dependency: its row is kept for information and the rule is not applied to it. `tests/unit/dependency-patches.test.ts` holds the arithmetic.

| Advisory            | Package                 | Direct | Published  | Patched    | Days | Note                                                                |
| ------------------- | ----------------------- | ------ | ---------- | ---------- | ---- | ------------------------------------------------------------------- |
| GHSA-p3m5-59mp-jv5r | `next` 16.4.0 to 16.4.3 | yes    | 2026-10-22 | 2026-10-26 | 4    | Commit `bc2b747`                                                    |
| GHSA-2464-fhr4-w9xw | `next` 16.4.0 to 16.4.3 | yes    | 2026-10-22 | 2026-10-26 | 4    | Commit `bc2b747`                                                    |
| GHSA-673q-mjm6-r5xr | `next` 16.4.0 to 16.4.3 | yes    | 2026-10-22 | 2026-10-26 | 4    | Commit `bc2b747`                                                    |
| GHSA-mrhx-c7xc-m3w5 | `zod`, by `better-auth` | no     | 2026-10-01 | 2026-10-26 | 25   | An override to 4.6.7, commit `63efd21`. Not direct; it took 25 days |
| GHSA-w74x-v6f9-j3xg | `fast-uri`, by `prisma` | no     | 2026-10-23 | 2026-10-26 | 3    | An override to 3.1.9, commit `63efd21`                              |
| GHSA-xhq7-xmqj-769h | `fast-uri`, by `prisma` | no     | 2026-10-23 | 2026-10-26 | 3    | The same                                                            |
| GHSA-wjr9-j795-jxcr | `fast-uri`, by `prisma` | no     | 2026-10-23 | 2026-10-26 | 3    | The same                                                            |
| GHSA-333x-w4r6-6crp | `fast-uri`, by `prisma` | no     | 2026-10-23 | 2026-10-26 | 3    | The same                                                            |

New row, when the audit reports an advisory: add it the day it is found, with the published day from the advisory, and the patched day when the patch is merged.
