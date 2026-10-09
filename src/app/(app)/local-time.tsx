'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { dateText } from '../../lib/date-text.ts';

const never = () => () => {};

/**
 * NFR-I18-06: a date is shown "in the user's local timezone as reported by the
 * browser". The server does not know that zone, so it renders no date at all,
 * and the browser writes it once the page is its own: nothing the server sent
 * is contradicted, and no date is ever shown in the server's zone. What is
 * given here, a sentence with a date in it, is rendered in the browser alone.
 */
export function InBrowser({ children }: { children: ReactNode }) {
  const inBrowser = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  return inBrowser ? children : null;
}

/**
 * A time, given in UTC (ISO 8601), shown in the zone of the browser in the one
 * form a person reads (src/lib/date-text.ts). Always inside `InBrowser`.
 */
export function LocalTime({ at }: { at: string }) {
  return <time dateTime={at}>{dateText(new Date(at))}</time>;
}
