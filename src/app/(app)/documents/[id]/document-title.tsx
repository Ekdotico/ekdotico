// The title of the document page, edited where it stands for an account that may
// rename the document (FR-ED-35; the owner's answers ux-name-in-document,
// ux-title-domico and ux-title-greek), and drawn as a heading for everyone else.
// The rename is the one the list of documents makes: PATCH /api/documents/[id],
// with its limits and its words.
'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EditableTitle, PageHeading } from '@ekdotico/domico/components';
import { send } from '../../../../components/send.ts';
import styles from '../../../pages.module.css';
import { RENAMED_STATEMENT } from '../../renamed-statement.ts';

// As `Heard` of the editor: the region is in the page throughout, emptied and
// then written, so that the same words can be spoken twice (WCAG 4.1.3).
const HEARD_AFTER_MS = 100;

export function DocumentTitle({
  documentId,
  title,
  canRename,
}: {
  documentId: string;
  title: string;
  canRename: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [said, setSaid] = useState({ text: '', count: 0 });
  const region = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = region.current;
    if (!element) return;
    element.textContent = '';
    if (!said.text) return;
    const timer = setTimeout(() => (element.textContent = said.text), HEARD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [said]);

  // The title is text, whatever it holds (NFR-SE-08).
  if (!canRename) return <PageHeading className={styles.breakable}>{title}</PageHeading>;

  async function save(next: string) {
    setPending(true);
    const refused = await send(`/api/documents/${documentId}`, { title: next }, 'PATCH');
    setPending(false);
    if (refused) {
      // The component does not announce a refusal; the page does, and draws it beside the field.
      const message = refused.fields?.title ?? refused.message;
      setError(message);
      setSaid((last) => ({ text: message, count: last.count + 1 }));
      return;
    }
    setError(undefined);
    setSaid((last) => ({ text: RENAMED_STATEMENT, count: last.count + 1 }));
    router.refresh();
  }

  return (
    <>
      <EditableTitle
        label="Title"
        value={title}
        onSave={save}
        pending={pending}
        error={error}
        className={styles.breakable}
      />
      <span ref={region} role="status" className="sr-only" data-heard="title" />
    </>
  );
}
