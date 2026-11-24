'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Button, Cluster, FormFault, Logo, NavDrawer } from '@ekdotico/domico/components';
import { AppearanceMenu } from '@ekdotico/domico/theme';
import { useReady } from '../../components/ready.ts';
import type { Fault } from '../../components/send.ts';
import { WIDGET_TEXT } from '../../lib/feedback/widget.ts';
import styles from '../pages.module.css';
import { FeedbackDialog } from './feedback-dialog.tsx';
import { NOTIFICATIONS_CHANGED } from './notifications/changed.ts';
import { SignOutButton } from './sign-out-button.tsx';

const DRAWER_ID = 'nav-drawer';

/**
 * FR-ED-42: the count of unread notifications, read again at each change of
 * page, since the header stays when the page changes. Where it cannot be
 * read, no count is shown: the list itself is one click away.
 */
function useUnread(): number {
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);
  // A page that changes the count without changing the address says so.
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    const changed = () => setChanges((count) => count + 1);
    window.addEventListener(NOTIFICATIONS_CHANGED, changed);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, changed);
  }, []);
  useEffect(() => {
    let current = true;
    fetch('/api/notifications', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { unread?: unknown } | null) => {
        if (current) setUnread(typeof body?.unread === 'number' ? body.unread : 0);
      })
      .catch(() => {
        if (current) setUnread(0);
      });
    return () => {
      current = false;
    };
  }, [pathname, changes]);
  return unread;
}

/**
 * The name of the phone header's trigger, and of the drawer it opens. The owner approved "Menu" on 23
 * November 2026. The drawer's close button keeps the package's own name.
 */
export const MENU_TEXT = 'Menu';

/**
 * The header of the signed-in pages: the product's name, which leads to the
 * list of documents, the notification list with its unread count (FR-ED-42),
 * the account settings (FR-AU-85), and the way to sign out (FR-AU-84).
 */
export function ShellHeader({ feedback }: { feedback: boolean }) {
  const pathname = usePathname();
  const ready = useReady();
  // The Feedback Widget (FR-AU-60, amended below 921px): one dialog, opened from the control in the row or from the one in
  // the drawer. From the drawer the drawer closes first and the dialog opens once it has, so that the dialog is not made
  // inert by the drawer's own modal surface; on closing, focus goes to the drawer's trigger, which is where the reader was.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackFromDrawer, setFeedbackFromDrawer] = useState(false);
  const openFeedback = (fromDrawer: boolean) => {
    setFeedbackFromDrawer(fromDrawer);
    if (fromDrawer) {
      setDrawerOpen(false);
      // After the render that closes the drawer, which lifts its hold on the page.
      window.setTimeout(() => setFeedbackOpen(true), 0);
    } else {
      setFeedbackOpen(true);
    }
  };
  const closeFeedback = () => {
    setFeedbackOpen(false);
    if (feedbackFromDrawer) {
      // After the dialog has returned focus to a control that is hidden now.
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`button[aria-controls="${DRAWER_ID}"]`)?.focus(),
      );
    }
  };
  const current = (path: string) =>
    pathname === path || pathname.startsWith(`${path}/`) ? ('page' as const) : undefined;
  const [fault, setFault] = useState<Fault | null>(null);
  const unread = useUnread();
  const links = (fromDrawer: boolean) => (
    <>
      <Link href="/" prefetch={false} aria-current={pathname === '/' ? 'page' : undefined}>
        Documents
      </Link>
      <Link href="/notifications" prefetch={false} aria-current={current('/notifications')}>
        Notifications
        {unread > 0 ? (
          <>
            {' '}
            <Badge variant="new">{`${unread} unread`}</Badge>
          </>
        ) : null}
      </Link>
      <Link href="/settings" prefetch={false} aria-current={current('/settings')}>
        Account settings
      </Link>
      {feedback ? (
        <Button variant="quiet" disabled={!ready} onClick={() => openFeedback(fromDrawer)}>
          {WIDGET_TEXT.control}
        </Button>
      ) : null}
      <SignOutButton variant="quiet" onFault={setFault} />
    </>
  );
  return (
    <>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <Link href="/" prefetch={false} className={styles.home}>
            <Logo />
          </Link>
          {/* UI audit F15: the design system's one appearance control, top right, with no props and no styling of ours.
              One instance only (two would claim one name), so it stays in the row at every width. */}
          <div className={styles.headerEnd}>
            {/* Modernisation A3: the same links twice, the row's from 921px and the drawer's below it; the
                other is display:none, so a screen reader meets one navigation. */}
            <nav aria-label="Main" className={styles.inlineNav}>
              <Cluster gap={4} align="center">
                {links(false)}
              </Cluster>
            </nav>
            <AppearanceMenu />
            <div className={styles.drawerOnly}>
              <NavDrawer
                label={MENU_TEXT}
                triggerLabel={MENU_TEXT}
                closeKey={pathname}
                id={DRAWER_ID}
                open={drawerOpen}
                onOpenChange={setDrawerOpen}
              >
                <nav aria-label="Main" className={styles.drawerNav}>
                  {links(true)}
                </nav>
              </NavDrawer>
            </div>
          </div>
        </div>
      </header>
      {fault ? (
        <div className={styles.fault}>
          {/* Announced, and focus stays on the button that was pressed, which
              is the way to try again. */}
          <FormFault title={fault.message} autoFocus={false} />
        </div>
      ) : null}
      {feedback ? <FeedbackDialog open={feedbackOpen} onClose={closeFeedback} /> : null}
    </>
  );
}
