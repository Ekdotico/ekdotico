# Procedure 3: behaviour at the connection limit

Criterion: a document allows ten connections, counted in the one collaboration server instance that the release runs, and an eleventh is refused with a stated message and a slow retry (NFR-PE-05, FR-ED-18). That the ten are counted across every instance is shown in the release that first runs a second instance (register D169, Q42). Source: the build-phases page at the draft register `docs-decisions@ee3a637`. The record is made with `node scripts/record.ts new connection-limit <release>`. Slice 25 holds the automated form of this limit; this is the run on the deployment.

## Before you start

- [ ] The release tested: ____ . The commit: ____ .

## Steps

- [ ] 1. Run the one collaboration server instance of the release.
- [ ] 2. Take a document with at least one Editor and one Viewer beside its Owner. Connections are counted by tab, so the ten may come from fewer than ten accounts. The document: ____ .
- [ ] 3. Open ten connections to the document, with at least one held by the Viewer. All ten show the document: ____ .
- [ ] 4. Open an eleventh connection. It is refused; the page shows "This document has reached its limit of ten connections. Ekdotico tries again every 30 seconds."; the sync status indicator does not show its error state (FR-ED-23). What was seen: ____ .
- [ ] 5. Not run in α 0.1.0. In the release that first runs a second instance: close the eleventh, and repeat step 4 with an eleventh connection that reaches the second instance (Q8 says how a connection is directed). Not run: ____ (write "not run in α 0.1.0").
- [ ] 6. Leave the refused page open for two minutes with the browser's network panel open. The time of each attempt to connect: ____ .
- [ ] 7. Close one of the ten connections. The refused page connects at its next attempt, without a reload: ____ .
- [ ] 8. Record the release tested (above) and the times of step 6 (above).

## Met when

The eleventh connection is refused; the statement is shown as written and the error state is not; no two attempts of step 6 are less than 30 seconds apart; and the page connects once a place is free.

## Result

Met: ____ (yes or no). Signed: ____ .
