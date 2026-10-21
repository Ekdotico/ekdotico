# The title and sender of an invitation, the hidden title, and the offers of ownership

Written on 21 October 2026 against the draft register at `docs-decisions@ee9640d` (D202, D207, D208, D215 to D223, Q49, Q55 to Q58; S17-5, S17-7). It records what the pull requests 53 and 54 build that later slices and the Docs owe something to, and the owner's decisions on them.

## Owed to later slices

| Slice                           | What is owed                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22 (account deletion, FR-AU-58) | `DocumentInvitation.titlePseudonym` holds a copy of the sender's display name, or the local part of the sender's address where there is no name. Nothing clears it. The deletion of an account must clear or replace the pseudonym of every invitation that account sent, and so must any other clearing of a sender's name. The clearing of the invited address (FR-ED-37) does not reach it                                         |
| 22 and 24                       | `withdrawOffersFor` now tells the Owner that an offer ended. Where the Editor's account is deleted, the notice names "the Editor" and not a person; the deletion of the Owner's account must not leave notices to it (FR-AU-58)                                                                                                                                                                                                       |
| Data migration                  | An invitation that was pending when the migration `20261021000000_invitation_title` ran has no pseudonym, so it reads as "title shown", and its invitee sees the title on the page and in the notification, which the rule before D202 did not show. No real user exists (α is used by the founding team), so nothing is back-filled; once there are users, a back-fill would have to decide what each pending invitation should show |

## Owed in the Docs

- The Data models page: the row of an invitation gains `titlePseudonym` and its meaning (D207 says the page is amended when this is built).
- NFR-SE-07: the row "Offers of ownership made, for each authenticated user: 20 in any hour" (D219). The setting is `RATE_LIMIT_OFFERS_PER_USER`.
- FR-ED-21, FR-ED-37, FR-ED-42, FR-ED-44 (a), FR-ED-47 and FR-ED-48: the amendments the register names for D215 to D220 (the fixed text of the reminder's email, FR-ED-44 (a)'s "none is refused except the holder's own", and FR-ED-37's sentence on an address of a user who holds a role).

## Decided by the owner on 21 October 2026

- Sending again keeps a hidden title hidden, with a new pseudonym. The choice "Hide the title" is made when an invitation is created and cannot be changed afterwards (D216).
- The Owner is told when an offer ends other than by an acceptance or the Owner's own withdrawal: a decline, an expiry, the Editor ceasing to hold the role (whoever caused it), and the deletion of the document (a move to the trash), one rule for the two cases FR-ED-47 calls "without anyone's action". A permanent deletion takes the notices (D217).
- The Owner's notice stays 30 days, as the notice of a removal does, read or unread, whether the document stands or is in the trash. It is shown to the account only while it is the Owner of the document (its words say "You are still its Owner"), so an acceptance deletes the former Owner's (D217; open as Q56).
- The reminder of an invitation, in the email and in the notification, names the sender by name and by address (D218).
- The limit on offers is its own count, 20 an hour (D219).
- An address whose account holds a role on the document is refused (409, `collaborator_address`, "already has access to this document"), the Owner's and a former Owner's included (D220). A person who has left the document, a former Owner among them, may be invited again. A request refused counts against the hourly limit on invitations, taken before the refusal, so that addresses cannot be probed without limit (D220).
- Built as recommended and open: the refusal is made only for an inviter who may see the people of the document, and an inviter shown no people is given the uniform answer of FR-ED-21 (Q55); the former Owner's notices go at a transfer (Q56); an address a collaborator no longer holds is not refused (Q57); invitations created before for such an address stay pending (Q58).
