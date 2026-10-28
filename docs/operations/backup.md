# The copy of the backups outside DigitalOcean

NFR-RE-10; register D105, D118, A28 (the role's name and privileges, and the credential's rights, are assumed). A logical dump of the `ekdotico` schema with the image objects, taken on a host of the deployment under `ekdotico_backup`, sealed on the host to a public key whose private half the founding team holds offline, and stored in a bucket at Scaleway in an EEA region. Made at least once a week (an initial value); each copy kept 4 weeks (an initial value). The job is the founding team's to run, and it is told of its failures. The restore from a copy is procedure 6, `docs/procedures/06-backup-and-restore.md`.

The commands are `scripts/backup.ts` (the job), `scripts/backup-restore.ts` (keys, opening, loading) and `scripts/backup-envelope.ts` (the format, which both use). The header of `backup.ts` states the six rules it keeps; `tests/integration/backup.test.ts` fails when any is broken.

## What the host needs

`node` 26, the repository's `scripts/`, `src/lib/images/storage.ts` and `node_modules` (`pnpm install --prod` is enough), and `pg_dump` and `psql` of the major version of the server or later. A copy is never made by a person at a keyboard with a password typed into a command line. **Run the job as an operating-system user of its own**, one that holds no other secret and that nothing else runs as: its password is in the environment of the tools it starts, and another process of the same user can read it (`ps -E`).

Settings, all in the environment of the job and none in a file (the job reads no `.env`):

| Name                                                                                                                                  | Meaning                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `BACKUP_DATABASE_URL`                                                                                                                 | The connection of `ekdotico_backup`, with `?sslmode=require` away from localhost                                                           |
| `BACKUP_PUBLIC_KEY_FILE`                                                                                                              | The path of the public key. A private key, an RSA key under 3,072 bits or another type is refused                                          |
| `BACKUP_STORE_ENDPOINT`, `BACKUP_STORE_BUCKET`, `BACKUP_STORE_REGION`, `BACKUP_STORE_ACCESS_KEY_ID`, `BACKUP_STORE_SECRET_ACCESS_KEY` | The bucket of the copies. An endpoint at DigitalOcean, or the bucket of the images, is refused                                             |
| `BACKUP_IMAGES_ENDPOINT`, `BACKUP_IMAGES_BUCKET`, `BACKUP_IMAGES_ACCESS_KEY_ID`, `BACKUP_IMAGES_SECRET_ACCESS_KEY`                    | A read credential for the bucket of the images. It needs `GetObject` and nothing else: the job names objects from the table and lists none |
| `BACKUP_WORK_DIRECTORY`                                                                                                               | Where the sealed file is written before it is stored (the system's temporary directory where unset). It is removed whatever happens        |

Exit codes: 0 the copy is stored; 1 a fault, nothing stored; 2 a refusal, nothing done. **A scheduler that runs it must alert the team on any status other than 0** (cron with a wrapper that posts to the team's channel, or the alerting of the platform that runs it: the owner's choice). A copy not made within 8 days is also a failure, and the owner sets that watch with the rest of the monitoring.

## Setting up, once, by the owner

1. **The key pair**, on a machine that is not a host of the deployment: `read -rs BACKUP_KEY_PASSPHRASE && export BACKUP_KEY_PASSPHRASE` (typed at the prompt, which echoes nothing, so that it is not in the history of the shell), then `node scripts/backup-restore.ts keygen --out <directory>`. `backup-public.pem` goes to the host. `backup-private.pem` and the passphrase are kept offline, in at least two places, by two people. Losing them makes every copy unreadable.
2. **The role.** `ekdotico_backup` is made by `scripts/provision.sql` (select on the schema, nothing else) with the password given to it there. The job refuses any role that can write, create or truncate, or that cannot read every table.
3. **The bucket at Scaleway**, in an EEA region, recorded in procedure 6: no public read, no listing; the credential the host holds can put and cannot delete. Register row R27-2: the protocol has no right to put only where nothing exists, so an overwrite of a key is, for a credential that may put, possible. The job gives every copy a key of its own (`backups/<year>/<month>/<time>-<random>.ekdbak`) and asks the store not to replace (`If-None-Match: *`). Make the bucket **versioned**, deny deletion of any version to the host's credential, and write the 4 weeks as a lifecycle rule that expires old versions as well as current objects, on the prefix `backups/`. **The host's credential holds no right over the bucket's configuration** (its lifecycle rule, its policy, its versioning): a credential that could change them could shorten the 4 weeks or lift the deny, so they are the owner's alone, set with another credential. Object Lock in compliance mode for 4 weeks is the alternative to the versioning and the deny. Which rights a Scaleway credential can be given and refused is for the owner to check in Scaleway's IAM, and to record in procedure 6; none of it is shown here.
4. **The image credential**: a Spaces key limited to the image bucket with read only.
5. **A first copy and a restore from it** before the first test user is admitted (procedure 6).

## What the seal gives, and what it does not

The seal gives secrecy (only the private half opens a copy) and integrity (a copy that was changed does not open: its tag does not match). It does **not** give origin. The key that seals is public, so anyone who holds it, or who finds it on the host, can make a copy that opens and shows the manifest of a real one. A copy proves that what it holds is whole, not who made it or that the host was sound when it was made. **After any suspected compromise of the host, restore from a copy made before it**, and not from the latest.

## What the job does not do

It does not delete, list or overwrite; it does not copy the `istorico` schema (register A28: for Istorico's owner, when Istorico is linked); it does not verify its own upload with a read, since the credential may not read; it does not measure the age of the copies. A copy of more than 5 GiB is refused by the format (`CEILING`) until the job stores in parts.
