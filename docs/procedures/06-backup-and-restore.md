# Procedure 6: backup and restore

Criterion: point-in-time recovery is switched on and a restore to a new cluster has been carried out, and a restore from the copy kept outside DigitalOcean has been carried out, before the first test user is admitted (NFR-RE-10). The first part is repeated at least once in every three months for as long as a 0.1.x release is hosted. The copy is kept in Scaleway object storage (register D118). Source: the build-phases page, "Backup and restore". The record is made with `node scripts/record.ts new backup-and-restore <release>`. How the copy is made, and what the host needs, is `docs/operations/backup.md`.

## Before you start

- [ ] The release tested: ____ . The commit: ____ . Next repeat due (three months): ____ .
- [ ] The choice for the image objects (NFR-RE-10, "the choice is recorded"): object versioning on the bucket, or a daily copy to a second bucket in FRA1: ____ . If versioning: the lifecycle rule that expires old versions after ____ days (deployment.md).
- [ ] The bucket of the copies at Scaleway: region ____ (an EEA region); admits no public read and no listing: ____ ; versioning ____ ; the rule that expires copies after 4 weeks, versions included: ____ ; what Scaleway's documentation says about a credential that adds and cannot delete or overwrite (register row R27-2): ____ .
- [ ] The key pair of the copies was made on a machine that is not a host of the deployment; the public file is on the host; the private file and its passphrase are held offline, in ____ places, by ____ .

## Steps

- [ ] 1. In the provider's control panel, point-in-time recovery is switched on for the managed cluster. The recovery window the provider states for the plan in use (register P13): ____ .
- [ ] 2. In the deployment, create a marker document that holds one sentence and one image. The time: ____ .
- [ ] 3. Wait at least ten minutes, then change the sentence. The time of the change: ____ .
- [ ] 4. Ask the provider for a point-in-time restore to a new cluster, at a time between the two recorded times. Requested at ____ ; the new cluster was ready at ____ .
- [ ] 5. Start a second copy of the application against the restored cluster, where no user can reach it, with read access to the image bucket.
- [ ] 6. Sign in to that copy and open the marker document. It shows the first sentence and not the changed one: ____ . Its image is shown: ____ .
- [ ] 7. Remove the restored cluster and the second copy of the application.
- [ ] 8. Fetch the most recent copy from its bucket in Scaleway object storage to a machine that is not a host of the deployment (the key is in the output of the job, `backups/…/….ekdbak`). The date of the copy: ____ . Its key: ____ .
- [ ] 9. Bring the private key from where it is held offline, and open the copy on that machine: `read -rs BACKUP_KEY_PASSPHRASE && export BACKUP_KEY_PASSPHRASE`, then `node scripts/backup-restore.ts decrypt --in <copy> --key <private.pem> --out <directory>`. It prints the number of entries and checks each against the manifest. If it is stopped with SIGINT or SIGTERM it removes the plain archive it made; if it is killed with SIGKILL or the machine loses power, it can leave `.archive.plain` in the directory, which is then removed by hand. The private key must be under a passphrase, or the command refuses it. A copy proves that it is whole and not who made it: after any suspected compromise of the host, use a copy made before it. Neither a host of the deployment nor the place that keeps the copy holds that key: ____ (confirmed how).
- [ ] 10. Create an empty PostgreSQL database with the `ekdotico` schema and its roles, by the provisioning script (`psql … -f scripts/provision.sql`, with fresh passwords), and load the dump into it as the migration role: `read -rs RESTORE_DATABASE_URL && export RESTORE_DATABASE_URL`, then `node scripts/backup-restore.ts database --dir <directory>`. Put the image objects of the copy into an empty bucket: `export RESTORE_IMAGES_ENDPOINT=… RESTORE_IMAGES_BUCKET=… RESTORE_IMAGES_ACCESS_KEY_ID=…` and `read -rs RESTORE_IMAGES_SECRET_ACCESS_KEY && export RESTORE_IMAGES_SECRET_ACCESS_KEY`, then `node scripts/backup-restore.ts images --dir <directory>`. The tables loaded: ____ ; the objects put: ____ .
- [ ] 11. Start a copy of the application against that database and that bucket, where no user can reach it. Sign in, and open a document that has images. The text and the images are shown: ____ .
- [ ] 12. Delete the database, the bucket and the decrypted files (the directory of step 9), and return the key to where it is held. Done: ____ .
- [ ] 13. For each of the two restores, the date, how long it took, and what was opened: point-in-time: ____ ; from the copy: ____ .

## Met when

The application restored to the requested time opens the marker document with its first sentence and its image; the application restored from the outside copy opens a document with its images; the private key was found nowhere but offline; and both restores are recorded.

## Result

Met: ____ (yes or no). Signed: ____ .
