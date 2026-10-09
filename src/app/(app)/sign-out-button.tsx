'use client';

import { useState } from 'react';
import { Button, type ButtonVariant } from '@ekdotico/domico/components';
import { useReady } from '../../components/ready.ts';
import { send, type Fault } from '../../components/send.ts';

/**
 * FR-AU-84: signing out ends the session at once, and the browser's cookies
 * are cleared. Then the sign-in page, by a full navigation, so that nothing
 * rendered for the account stays in the browser's memory of the pages.
 */
export function SignOutButton({
  variant,
  onFault,
}: {
  variant: ButtonVariant;
  /** A sign-out that did not complete is stated in text by whoever holds the button. */
  onFault: (fault: Fault | null) => void;
}) {
  const ready = useReady();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant={variant}
      disabled={!ready}
      pending={pending}
      pendingLabel="Signing out…"
      onClick={async () => {
        setPending(true);
        onFault(null);
        const refused = await send('/api/auth/sign-out');
        // A session that had ended already is signed out all the same.
        if (!refused || refused.code === 'unauthenticated') {
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full navigation on purpose: the router would keep the pages it rendered for the account
          window.location.assign('/sign-in');
          return;
        }
        onFault(refused);
        setPending(false);
      }}
    >
      Sign out
    </Button>
  );
}
