// The control of the Markdown draft export (FR-EX-01 (a), FR-EX-36; docs/plan/slice-21.md, section 7). A button on
// the page of a document, shown to a role that holds `document.export.draft` (FR-ED-44); the page reads the role
// and the permission set again from the server when the editor is told that either changed (./editor.tsx,
// FR-ED-40 (g)).
//
// The archive is asked for with a POST, and read to its end before it is saved: a statement of a refusal is then
// shown on the page in the words the route gave, and a response that does not arrive whole is a statement and no
// file (register row S21-4 has the alternative, a form that the browser follows to a download). The server holds
// no copy; the browser holds the file once, here, until it has been handed over to be saved.
//
// The words are the application's: no requirement gives any (the owner's answer to Q6 of the plan: approved with
// the pull request).
'use client';

import { useState } from 'react';
import { Button, FormFault, Stack } from '@ekdotico/domico/components';
import { useReady } from '../../../../components/ready.ts';
import pageStyles from '../../../pages.module.css';

const LABEL = 'Export as Markdown';
const WORKING = 'Preparing the export…';
const READY = 'The export is ready. Your browser is saving the file.';
const FAILED = 'The export did not complete, and no file was saved. Try again.';

/** The file name a `Content-Disposition` header gives, as RFC 6266 has it: the UTF-8 form first. */
export function nameFrom(header: string | null): string {
  const encoded = /filename\*=UTF-8''([^;]*)/iu.exec(header ?? '')?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Not a form it can read: the plain one.
    }
  }
  return /filename="([^"]*)"/iu.exec(header ?? '')?.[1] ?? 'document.zip';
}

/** Hands a file to the browser to be saved under a name. */
function save(blob: Blob, name: string) {
  const address = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = address;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // After the browser has taken it up.
  setTimeout(() => URL.revokeObjectURL(address), 60_000);
}

export function ExportDraft({ documentId }: { documentId: string }) {
  const ready = useReady();
  const [working, setWorking] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState(0);

  async function run() {
    if (working) return;
    setWorking(true);
    setFault(null);
    const failed = (message: string) => {
      setFault(message);
      setAttempt((count) => count + 1);
    };
    try {
      let response: Response;
      try {
        response = await fetch(`/api/documents/${documentId}/export/draft`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          // Every route answers in JSON or with the file, and none redirects.
          redirect: 'error',
        });
      } catch {
        return failed(FAILED);
      }
      if (!response.ok) {
        // The one error shape: the message is the route's, for a person (src/lib/http.ts).
        const { error } = (await response.json().catch(() => ({}))) as { error?: { message?: unknown } };
        return failed(typeof error?.message === 'string' && error.message ? error.message : FAILED);
      }
      let file: Blob;
      try {
        // Read to its end: a response that stops before it does is an error here, and no file.
        file = await response.blob();
      } catch {
        return failed(FAILED);
      }
      save(file, nameFrom(response.headers.get('content-disposition')));
      setSaved((count) => count + 1);
    } finally {
      setWorking(false);
    }
  }

  return (
    <Stack gap={3}>
      <div>
        <Button disabled={!ready} pending={working} pendingLabel={WORKING} onClick={() => void run()}>
          {LABEL}
        </Button>
      </div>
      {fault ? <FormFault title={fault} focusKey={attempt} /> : null}
      {/* Present before it has anything to say, so that what it says is announced. */}
      <p role="status" className={saved > 0 && !fault && !working ? pageStyles.text : 'sr-only'}>
        {saved > 0 && !fault && !working ? READY : ''}
      </p>
    </Stack>
  );
}
