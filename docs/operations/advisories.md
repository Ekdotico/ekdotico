# Security advisories

The check is `.github/workflows/advisories.yml`: `pnpm audit --audit-level low`, on every pull request, on every push to `main`, and once a day (NFR-IC-20, NFR-IC-10). By the owner's decision of 8 October 2026 it covers all dependencies, development ones included, at every severity, and a run fails on any finding that is not ignored below.

A finding is fixed where it can be: by an update, or by an exact override in `pnpm.overrides` of `package.json`. Only a finding that cannot be fixed is ignored, by its advisory identifier in `pnpm.auditConfig.ignoreGhsas`, with a dated reason in the table here. Each ignore is a decision the owner approves. `tests/unit/advisories.test.ts` fails where an identifier is ignored without a row, or a row stands without its identifier being ignored.

## Ignored

Read each row again when its package, or the package it arrives by, is updated; remove the row and the identifier together once a fixed version exists.

| Advisory            | Date       | Package and path                                                                                  | Why it does not reach the application                                                                                                                                                                                                                |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GHSA-vfj7-8cjw-p6xm | 2026-10-08 | `braces` 3.0.3, by `eslint-config-next` > `@next/eslint-plugin-next` > `fast-glob` > `micromatch` | No fixed version is published. The package is installed only for the lint run, is in no build and no running process, and expands only the patterns written in the lint plugin, never text from a request, so its fault can at most stop a lint run. |

## Fixed by an override

An override holds a package that another package asks for at a version with an advisory. Remove one when the package that asks for it asks for a fixed version itself.

| Advisory                                 | Date       | Package and path                                           | Override                                                                                                |
| ---------------------------------------- | ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GHSA-ggr8-5vv4-36mx                      | 2026-10-08 | `deepmerge-ts`, by `prisma` > `@prisma/config`             | 7.1.5 to 8.0.2. Published 17 August 2026                                                                |
| GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3 | 2026-10-08 | `mysql2`, by `prisma` (and a peer of the identity library) | 3.15.3 to 3.24.5. Published 1 September and 31 August 2026. The application connects to no MySQL server |
