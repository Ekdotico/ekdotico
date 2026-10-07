# 0003 — Tools the specification does not name

- **Date:** 7 October 2026.
- **Requirement:** NFR-IC-01 leaves these to the implementer; register P16 asks that each tool used to test a criterion is recorded with its version when its test is first written.

| Purpose                    | Tool                             | Version        |
| -------------------------- | -------------------------------- | -------------- |
| Package manager            | pnpm                             | 10.33.2        |
| Unit and integration tests | Vitest                           | 5.0.3          |
| End-to-end tests           | Playwright                       | 1.63.0         |
| Lint                       | ESLint with `eslint-config-next` | 9.39.5, 16.4.0 |
| Format                     | Prettier                         | 3.9.9          |

Integration tests run against a real PostgreSQL server and never against a mock of it, so that a test of a privilege fails when the privilege is wrong.

Not yet chosen, and recorded here when first used: the automated accessibility checker, the screen reader of the manual pass, the tool that holds ten collaboration connections, and the health checker (register P16).
