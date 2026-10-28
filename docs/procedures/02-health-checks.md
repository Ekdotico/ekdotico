# Procedure 2: health checks and alerting

Criterion: the health check of the application and of the collaboration server is called every minute from a location in the EEA, and the founding team is alerted on two consecutive failures (NFR-RE-03, NFR-SE-05). Source: the build-phases page, "How each criterion is tested". The record is made with `node scripts/record.ts new health-checks <release>`.

## Before you start

- [ ] The release tested: ____ . The commit: ____ .
- [ ] The checker chosen for this test (register P16: the owner's; an outside service is given no personal data, so it is not a processor): ____ , version or plan ____ . The channel by which it alerts each member of the team: ____ .

## Steps

- [ ] 1. Request the health-check path of the application (`/api/health`) and that of the collaboration server (`/collab/health`) by hand, without a session. Each answers with success and returns nothing about a user or a document. Status and body length of the first: ____ ; of the second: ____ .
- [ ] 2. Set up the checker to call each of the two paths once a minute from a location in the EEA. The location: ____ . The channel for each member of the team: ____ .
- [ ] 3. The checker holds no personal data: its configuration is the two addresses, the interval and the alert channel. Confirmed from its configuration: ____ .
- [ ] 4. Leave the checker running for one hour. From its own record, calls to the first path: ____ ; to the second: ____ ; calls that did not succeed: ____ .
- [ ] 5. At a time agreed with the team, stop the collaboration server. The time: ____ .
- [ ] 6. The time at which the alert reaches each member of the team, and which check it names: ____ .
- [ ] 7. Start the collaboration server again. The checker records the recovery: ____ . No further alert was raised: ____ .
- [ ] 8. Repeat steps 5 to 7 for the web application. Stopped at ____ ; alerts at ____ ; recovery at ____ .

## Met when

Each of the two stops raised an alert to every member of the founding team, no earlier than the second failed check and no later than the third, and the hour of step 4 raised none.

## Result

Met: ____ (yes or no). Signed: ____ .
