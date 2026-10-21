// Makes the bucket of the images on the local object store of compose.yaml, and
// does nothing where it is there. For a development machine and for CI alone: it
// refuses an endpoint that is not on localhost, since the bucket of DigitalOcean
// Spaces is the owner's to provision (NFR-SE-18).
//
//   node scripts/create-bucket.ts
//
// It reads the settings of the object store as the application does (`.env.example`):
// IMAGE_STORAGE_ENDPOINT, IMAGE_STORAGE_BUCKET and the two keys, from the
// environment of the shell. It waits for the store to answer, for up to 60 seconds.
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';

const {
  IMAGE_STORAGE_ENDPOINT,
  IMAGE_STORAGE_BUCKET,
  IMAGE_STORAGE_ACCESS_KEY_ID,
  IMAGE_STORAGE_SECRET_ACCESS_KEY,
} = process.env;
if (
  !IMAGE_STORAGE_ENDPOINT ||
  !IMAGE_STORAGE_BUCKET ||
  !IMAGE_STORAGE_ACCESS_KEY_ID ||
  !IMAGE_STORAGE_SECRET_ACCESS_KEY
) {
  console.error('IMAGE_STORAGE_ENDPOINT, IMAGE_STORAGE_BUCKET and the two keys must be set.');
  process.exit(1);
}
if (!['localhost', '127.0.0.1'].includes(new URL(IMAGE_STORAGE_ENDPOINT).hostname)) {
  console.error(
    'This makes a bucket on a store on this machine alone: IMAGE_STORAGE_ENDPOINT is not on localhost.',
  );
  process.exit(1);
}

const client = new S3Client({
  endpoint: IMAGE_STORAGE_ENDPOINT,
  region: process.env.IMAGE_STORAGE_REGION || 'fra1',
  forcePathStyle: true,
  credentials: { accessKeyId: IMAGE_STORAGE_ACCESS_KEY_ID, secretAccessKey: IMAGE_STORAGE_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  maxAttempts: 1,
});

const deadline = Date.now() + 60_000;
for (;;) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: IMAGE_STORAGE_BUCKET }));
    console.log(`Bucket ${IMAGE_STORAGE_BUCKET} is made.`);
    break;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
      console.log(`Bucket ${IMAGE_STORAGE_BUCKET} is there.`);
      break;
    }
    if (Date.now() > deadline) {
      console.error(`The object store did not answer: ${name ?? 'a fault'}.`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
client.destroy();
