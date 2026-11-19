'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Cluster, FormFault, Logo, NavDrawer } from '@ekdotico/domico/components';
import { AppearanceMenu } from '@ekdotico/domico/theme';
import type { Fault } from '../../components/send.ts';
import styles from '../pages.module.css';
import { NOTIFICATIONS_CHANGED } from './notifications/changed.ts';
import { SignOutButton } from './sign-out-button.tsx';

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
 * The name of the phone header's trigger, and of the drawer it opens. PROPOSED, NOT YET APPROVED by the
 * owner (question ui-mod-texts): do not push this branch until it is. The drawer's close button keeps the
 * package's own name.
 */
export const MENU_TEXT = 'Menu';

/**
 * The header of the signed-in pages: the product's name, which leads to the
 * list of documents, the notification list with its unread count (FR-ED-42),
 * the account settings (FR-AU-85), and the way to sign out (FR-AU-84).
 */
export function ShellHeader() {
  const pathname = usePathname();
  const current = (path: string) =>
    pathname === path || pathname.startsWith(`${path}/`) ? ('page' as const) : undefined;
  const [fault, setFault] = useState<Fault | null>(null);
  const unread = useUnread();
  const links = (
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
                {links}
              </Cluster>
            </nav>
            <AppearanceMenu />
            <div className={styles.drawerOnly}>
              <NavDrawer label={MENU_TEXT} triggerLabel={MENU_TEXT} closeKey={pathname}>
                <nav aria-label="Main" className={styles.drawerNav}>
                  {links}
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
    </>
  );
}
