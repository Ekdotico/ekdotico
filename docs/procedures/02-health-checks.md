# Procedure 2: health checks and alerting

Criterion: the server calls the health check of the application and that of the collaboration server on their public addresses every minute and checks in with Healthchecks.io after each success, and the service emails the owner when the check-ins stop (NFR-RE-03, NFR-SE-05; register D280). In Ekdotico α 0.1.0 the alert goes to the owner alone. The outside check is the two DigitalOcean uptime checks, which are recorded as such. Source: the build-phases page, "How each criterion is tested". The record is made with `node scripts/record.ts new health-checks <release>`.

Two alerts are tested, each with its own window: the one of Healthchecks.io, which follows the server's own check-ins, and the one of DigitalOcean's uptime checks, which call the same two paths from outside. No ping address, check identifier or server address is written in this file or in the record.

## Before you start

- [ ] The release tested: ____ . The commit: ____ .
- [ ] The checkers of this test (register P16, D275, D280; an outside service is given no personal data beyond the owner's address): Healthchecks.io, plan ____ ; DigitalOcean uptime checks, the two. The owner is the only recipient of the alert in α 0.1.0. The channel by which each alerts the owner: ____ .

## Steps

- [ ] 1. Request the health-check path of the application (`/api/health`) and that of the collaboration server (`/collab/health`) by hand, without a session. Each answers with success and returns nothing about a user or a document. Status and body length of the first: ____ ; of the second: ____ .
- [ ] 2. Set up the two checks in Healthchecks.io (the server calls the two paths every minute and checks in after each success). The period is one minute and the grace time is two minutes. Period ____ ; grace time ____ ; the address to which the service sends its emails (the owner's, not written here): ____ .
- [ ] 3. Set up the two DigitalOcean uptime checks, one for each path, with an alert to the owner. They count as the outside check, called from a location outside the server (the location and the interval, as the service shows them): ____ ; alert threshold set in the service: ____ .
- [ ] 4. The checkers hold no personal data beyond the owner's address: the configuration of each check is a name, the period, the grace time (or the interval and the threshold) and that address, and a check-in carries no user and no document. Confirmed from their configuration: ____ .
- [ ] 5. Leave the checks running for one hour. From the service's own record, check-ins to each Healthchecks.io check: ____ (about sixty); DigitalOcean calls that did not succeed: ____ ; alerts raised by either: ____ (none).
- [ ] 6. At a time agreed with the team, stop the collaboration server. The time: ____ .
- [ ] 7. The time at which the email of Healthchecks.io reaches the owner, and which check it names: ____ . The time at which the alert of DigitalOcean reaches the owner, and which check it names: ____ .
- [ ] 8. Start the collaboration server again. Each service records the recovery: ____ . No further alert was raised: ____ .
- [ ] 9. Repeat steps 6 to 8 for the web application. Stopped at ____ ; alerts at ____ (Healthchecks.io) and ____ (DigitalOcean); recovery at ____ .

## Met when

Each of the two stops raised an email to the owner from Healthchecks.io that names the check, no later than five minutes after the last check-in (one minute of period and two of grace, as recorded in step 2, and up to two minutes for the service to send the email and for it to arrive; register D395), and, from the DigitalOcean checks, an alert to the owner no earlier than the second failed check and no later than the third; and the hour of step 5 raised no alert from either.

## Result

Met: ____ (yes or no). Signed: ____ .
