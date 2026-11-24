'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Badge, Button, Cluster, FormFault, Stack } from '@ekdotico/domico/components';
import { useReady } from '../../../components/ready.ts';
import { send, type Fault } from '../../../components/send.ts';
import type { SessionView } from '../../../lib/auth/session-list.ts';
import { dateText } from '../../../lib/date-text.ts';
import styles from '../../pages.module.css';

const never = () => () => {};

/**
 * A time in the reader's own time zone, "as reported by the browser"
 * (NFR-I18-06), in the one form a person reads (src/lib/date-text.ts). The
 * server cannot know the zone, so it writes the time in UTC and says so, and
 * the browser replaces it once the page is its own.
 */
function LocalTime({ value }: { value: string }) {
  const date = new Date(value);
  const text = useSyncExternalStore(
    never,
    () => dateText(date),
    () => dateText(date, 'utc'),
  );
  return <time dateTime={value}>{text}</time>;
}

// Text for a person (the owner's answer to Q6 of the plan). A label, so three
// words at most and no article (Expression Guidelines, functional, rules 1 and 8).
const UNNAMED = 'Unnamed browser';

// The owner's approved statements (23 November 2026), and the name of the control on the session in use.
export const SESSION_ENDED = 'Session ended.';
export const OTHER_SESSIONS_ENDED = 'Other sessions ended.';
export const END_OWN_SESSION = 'End this session and sign out';

/** "Firefox on macOS": the browser's name and the operating system family (FR-AU-85), as far as each is known. */
const named = ({ browser, system }: SessionView) =>
  system ? `${browser ?? 'Browser'} on ${system}` : (browser ?? UNNAMED);

/**
 * FR-AU-85: for each session when it began, when it was last renewed, the
 * browser and the system, and which one is in use; no network address. Any one
 * can be ended, and all but the one in use, "in one action each".
 */
export function SessionList({ sessions }: { sessions: readonly SessionView[] }) {
  const router = useRouter();
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The identifier of the session being ended, or 'others'.
  const [pending, setPending] = useState<string | null>(null);
  const ready = useReady();
  // Present from the first paint and empty until something is done: a status that arrives with its text is
  // not announced. It takes focus once it has its text, since the button that had focus is gone.
  const statement = useRef<HTMLParagraphElement>(null);
  const [said, setSaid] = useState({ text: '', count: 0 });
  useEffect(() => {
    if (said.count > 0) statement.current?.focus();
  }, [said]);

  async function end(path: string, which: string, body?: unknown, own = false) {
    setPending(which);
    setFault(null);
    setSaid((now) => ({ ...now, text: '' }));
    const refused = await send(path, body);
    if (refused ? refused.code === 'unauthenticated' : own) {
      // The session in use was ended, here and now or elsewhere before, which
      // is a sign-out (FR-AU-84).
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full navigation on purpose: the router would keep the pages it rendered for the account
      window.location.assign('/sign-in');
      return;
    }
    if (refused) {
      setFault(refused);
      setAttempt((count) => count + 1);
    } else {
      setSaid((now) => ({
        text: which === 'others' ? OTHER_SESSIONS_ENDED : SESSION_ENDED,
        count: now.count + 1,
      }));
    }
    // Read again in either case: a session that could not be ended may have ended already.
    router.refresh();
    setPending(null);
  }

  return (
    <Stack gap={5}>
      {fault ? <FormFault title={fault.message} focusKey={attempt} headingLevel={3} /> : null}
      <p role="status" ref={statement} tabIndex={-1} className={styles.text}>
        {said.text}
      </p>
      <ul className={styles.sessionList}>
        {sessions.map((session) => (
          <li key={session.id} className={styles.item}>
            <Stack gap={3}>
              <Cluster gap={3} align="center">
                <span id={`session-${session.id}`}>{named(session)}</span>
                {session.current ? <Badge variant="info">This session</Badge> : null}
              </Cluster>
              <p className={styles.meta}>
                Began <LocalTime value={session.beganAt} />. Last renewed{' '}
                <LocalTime value={session.renewedAt} />.
              </p>
              <div>
                <Button
                  variant="secondary"
                  // The same label on each; what it ends is read with it.
                  aria-describedby={`session-${session.id}`}
                  disabled={!ready}
                  pending={pending === session.id}
                  pendingLabel="Ending session…"
                  onClick={() =>
                    end('/api/auth/revoke-session', session.id, { id: session.id }, session.current)
                  }
                >
                  {session.current ? END_OWN_SESSION : 'End session'}
                </Button>
              </div>
            </Stack>
          </li>
        ))}
      </ul>
      {sessions.some((session) => !session.current) ? (
        <div>
          <Button
            variant="secondary"
            disabled={!ready}
            pending={pending === 'others'}
            pendingLabel="Ending sessions…"
            onClick={() => end('/api/auth/revoke-other-sessions', 'others')}
          >
            End other sessions
          </Button>
        </div>
      ) : null}
    </Stack>
  );
}
