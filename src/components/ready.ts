'use client';

// Whether the page's script has taken over the markup the server sent. Until
// it has, a control that works by script alone does nothing when it is
// pressed, and a form posts itself to the address of its page: so such a
// control is `disabled` until then, which a person and a screen reader can
// both tell (NFR-IC-19), and it is pressed once and works. The package's
// `Button` passes `disabled` through "for an action that is unavailable".
import { useSyncExternalStore } from 'react';

const never = () => () => {};

/** False in the server's markup and while the browser takes it over; true from then on. */
export function useReady(): boolean {
  return useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
}
