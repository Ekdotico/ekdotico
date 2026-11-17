// The top of the sharing settings: the heading, the document it concerns and the way back to it
// (UI audit F04). The title is the one the document page shows, read under the same `document.view`
// authorisation, and is text whatever it holds (NFR-SE-08).
import Link from 'next/link';
import { PageHeading, Stack } from '@ekdotico/domico/components';
import styles from '../../../../pages.module.css';

export function SharingHead({ documentId, title }: { documentId: string; title: string }) {
  return (
    <Stack gap={3}>
      <PageHeading>Sharing</PageHeading>
      <p className={styles.text}>
        Document: <bdi>{title}</bdi>
      </p>
      <p className={styles.text}>
        <Link href={`/documents/${documentId}`} prefetch={false}>
          Back to document
        </Link>
      </p>
    </Stack>
  );
}
