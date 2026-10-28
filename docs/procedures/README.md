# The procedures that show the release criteria

Six procedures, copied from the build-phases page ("How each criterion is tested", at the draft register `docs-decisions@ee3a637`) with a box for each step and a field for each thing a step says to record, and the procedure for rotating the secrets (NFR-SE-17 (e), `docs/operations/secret-rotation.md`). A member of the team follows one in order, on the Frankfurt deployment, and its record stays in this repository with its date and the release tested.

| #   | Procedure                                                | Criterion            | Record goes in                          |
| --- | -------------------------------------------------------- | -------------------- | --------------------------------------- |
| 1   | [Editor performance](01-editor-performance.md)           | NFR-PE-01, NFR-IC-14 | `docs/records/runs/editor-performance/` |
| 2   | [Health checks](02-health-checks.md)                     | NFR-RE-03, NFR-SE-05 | `docs/records/runs/health-checks/`      |
| 3   | [Connection limit](03-connection-limit.md)               | NFR-PE-05, FR-ED-18  | `docs/records/runs/connection-limit/`   |
| 4   | [Accessibility](04-accessibility.md)                     | NFR-IC-19            | `docs/records/runs/accessibility/`      |
| 5   | [Browsers](05-browsers.md)                               | NFR-IC-05            | `docs/records/runs/browsers/`           |
| 6   | [Backup and restore](06-backup-and-restore.md)           | NFR-RE-10            | `docs/records/runs/backup-and-restore/` |
| —   | [Rotating the secrets](../operations/secret-rotation.md) | NFR-SE-17 (e)        | `docs/records/runs/secret-rotation/`    |

```bash
node scripts/record.ts new editor-performance 0.1.0    # makes docs/records/runs/editor-performance/<date>-0.1.0.md from the procedure
node scripts/record.ts check docs/records/runs/editor-performance/<file>.md   # exits 1 while a box is unticked or a field is blank
```

Tick a box when the step is done and write in each `____`. A step that cannot be done in this release says so in its field ("not run in α 0.1.0") and is ticked. The record holds no secret, no cookie and no address of a person. Whether the criterion is met is the sentence "Met when" read against what is written; `check` says the record is complete and nothing more.

Other records: [the match of every store to §2.7](../records/storage-match.md), [the processors](../records/processors.md). The sentences of the procedures are the Docs' and are the Docs' to change; a change there is a change here (`tests/unit/procedures.test.ts` holds the number of steps).
