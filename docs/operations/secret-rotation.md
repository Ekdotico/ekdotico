# Rotating the secrets

NFR-SE-17 (e): the secrets "are rotated by a procedure that is recorded in the `ekdotico` repository before the first test user is admitted". This is that procedure. The owner runs it on the deployment; nothing here is run from a development machine against production. The record of each rotation is kept in `docs/records/runs/secret-rotation/`, made by `node scripts/record.ts new secret-rotation <release>`.

Every secret differs from every other and from those of any other environment (NFR-SE-17 (e); `settings.ts` refuses a repeat among `AUTH_SECRET`, `ADMISSION_SECRET` and the key of the image store). A new value is made with `node scripts/dev-secret.mjs`, which prints one and writes nothing. A value is never put in a commit, a ticket, a log or a chat; it goes from the place that made it to the environment of the deployment and nowhere else. The feedback secret of NFR-SE-17 (e) does not exist in α 0.1.0 (build-phases).

## What there is, what depends on it, what a rotation ends

| Secret                                  | Held in                                               | What depends on it                                                                                                                                                                | What a rotation ends                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`                           | The web application and the collaboration server      | The signature of the session cookie and of the cookie cache; the key under which the second factor and its recovery codes are sealed (NFR-SE-17 (a)); the keyed digests in Valkey | Every session. The second factor of every account, unless step 3 is done. The counts of NFR-SE-07, which restart from zero (see the note) |
| `ADMISSION_SECRET`                      | The web application, and the command `pnpm admission` | The signature of the admission requests (FR-AU-89)                                                                                                                                | Requests signed with the old value, until the command has the new. No stored data                                                         |
| `IMAGE_STORAGE_SECRET_ACCESS_KEY`       | The web application and the collaboration server      | The reading and writing of the image objects                                                                                                                                      | Nothing stored; an upload or a link fails between the switch and the restart                                                              |
| The password of `ekdotico_app`          | `DATABASE_URL` of both processes                      | Every query of the application                                                                                                                                                    | Both processes, until they have the new value                                                                                             |
| The password of `ekdotico_migrate`      | The deployment pipeline (`MIGRATE_DATABASE_URL`)      | The migrations                                                                                                                                                                    | Nothing running                                                                                                                           |
| The password of `ekdotico_backup`       | The backup job (`BACKUP_DATABASE_URL`)                | The copy of the backups                                                                                                                                                           | The next copy, until the job has the new value                                                                                            |
| The credential for the bucket of copies | The backup job (`BACKUP_STORE_*`)                     | The storing of a copy                                                                                                                                                             | The next copy                                                                                                                             |
| The read credential for the images      | The backup job (`BACKUP_IMAGES_*`)                    | The copying of the image objects                                                                                                                                                  | The next copy                                                                                                                             |
| The key of the Valkey cluster           | `VALKEY_URL` of both processes                        | Counters, locks and the channel of events                                                                                                                                         | Both processes, until they have the new value. The counters are lost                                                                      |
| The key of Brevo                        | Not held: nothing is sent (Q50)                       | —                                                                                                                                                                                 | —                                                                                                                                         |

The private half of the key of the copies is not a secret of the server environment: it is never on a host of the deployment. Its replacement is step 6.

Rotate each secret when a person who held it leaves, when one may have been seen, and in any case at least once a year (an initial value; the owner sets it). A secret that may have been seen is rotated at once, and the record says so.

## 1. A secret that is only an environment variable

For `ADMISSION_SECRET`, the Spaces key, the passwords of the roles, the Valkey key and the credentials of the job:

- [ ] Make the new value (for a password: `ALTER ROLE … PASSWORD` is run by the administrator, not by the application; for a Spaces key or a Scaleway credential: make a second key in the provider's panel, and leave the old one until the last step). Record the date and which secret, never the value.
- [ ] Set it in the environment of everything that holds it (the table above).
- [ ] Restart those processes, one after another, with the health check of each answering before the next (`GET /api/health`, `GET /collab/health`).
- [ ] Prove the new value works: an admission request (`pnpm admission list`) for `ADMISSION_SECRET`; an upload and an image shown for the Spaces key; a sign-in for the database passwords; one copy (procedure 6, step 8 begins from it) for the job's credentials.
- [ ] Revoke the old value at its source (the old Spaces key, the old credential). Prove that the old value is refused.
- [ ] Record: the date, the secret, the person, the reason, what was proved, and that the old value is revoked.

## 2. `AUTH_SECRET`

It ends every session and all second factors unless step 3 is done, so it is done at a time agreed with the founding team, who sign in again afterwards and need their authenticator application.

- [ ] Agree the time. Take a copy of the database first (procedure 6, steps 8 to 9 for the latest copy, or a manual dump), since step 3 changes rows.
- [ ] Make the new value: `node scripts/dev-secret.mjs`. Hold it in the place the team keeps secrets, not in the shell history.
- [ ] Run step 3 as a dry run. It prints counts and changes nothing.
- [ ] Stop both processes (the application and the collaboration server). A process that runs with the old value while step 3 runs would write a second factor sealed under the old value.
- [ ] Run step 3 with `--apply`.
- [ ] Set `AUTH_SECRET` to the new value in both processes, and start them. They must hold the same value.
- [ ] Prove it: sign in as a member of the founding team with the password and a code from the authenticator application; a recovery code was not used up by the proof. Confirm that a session cookie from before the rotation is refused (401).
- [ ] Record: the date, the person, the reason, the counts step 3 printed, what was proved.

Note on Valkey: the counts of NFR-SE-07 and the marks of used codes are stored under digests keyed by `AUTH_SECRET`, so they restart from zero. A person who was part-way to a lock starts again, and a one-time code used a moment before is accepted once more within its 90 seconds. This is accepted for a rotation; it is why the time is agreed.

## 3. Re-sealing the second factor

`OLD_AUTH_SECRET` and `NEW_AUTH_SECRET` are put in the environment of one command, which is run on a host of the deployment, with `DATABASE_URL` of the runtime role:

```bash
OLD_AUTH_SECRET=… NEW_AUTH_SECRET=… DATABASE_URL=… node scripts/rotate-auth-secret.ts            # a dry run
OLD_AUTH_SECRET=… NEW_AUTH_SECRET=… DATABASE_URL=… node scripts/rotate-auth-secret.ts --apply
```

It opens each `TwoFactor.secret` and `TwoFactor.backupCodes` with the old value, seals it with the new one, and deletes every `Session` row, in one transaction. It prints counts and no value. A row that opens under neither value stops it with nothing changed; the owner then decides what becomes of that account (the library's own way to rotate without loss, `BETTER_AUTH_SECRETS`, is refused by `settings.ts` and is register row R27-3). A run that is repeated finds the rows under the new value and changes nothing twice. `tests/integration/rotate-auth-secret.test.ts` shows each of these.

## 4. The record

`docs/records/runs/secret-rotation/<date>-<release>.md` holds, for each rotation: the date; who; which secret; why; the steps above ticked; what was proved; and that nothing was printed or committed. It holds no value, no part of a value and no hash of one.

## 5. If a secret is lost or published

Treat it as seen: rotate it at once, then read the security log for the days it was exposed (`SecurityLogEntry`), and tell the owner. A published `AUTH_SECRET` lets its holder forge a session cookie, so after the rotation every session the deployment has made is gone and every founding-team account is asked for its second factor again.

## 6. The key of the copies

The pair is made on a machine that is not a host of the deployment: `BACKUP_KEY_PASSPHRASE=… node scripts/backup-restore.ts keygen --out <directory>` (docs/operations/backup.md). The public file goes to the host. To replace it: make a new pair, put the new public file on the host, make one copy, and open it with the new private key (procedure 6, steps 8 and 9) before the old private key is retired. **Keep the old private key until the last copy sealed to it has expired**, 4 weeks: it is the only way to open those copies.
