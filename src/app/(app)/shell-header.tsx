'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Cluster, FormFault, Logo } from '@ekdotico/domico/components';
import type { Fault } from '../../components/send.ts';
import styles from '../pages.module.css';
import { SignOutButton } from './sign-out-button.tsx';

/**
 * The header of the signed-in pages: the product's name, which leads to the
 * first page, the account settings (FR-AU-85), and the way to sign out
 * (FR-AU-84).
 */
export function ShellHeader() {
  const [fault, setFault] = useState<Fault | null>(null);
  return (
    <>
      <header className={styles.header}>
        <Link href="/" className={styles.home}>
          <Logo />
        </Link>
        <Cluster gap={4} align="center">
          <Link href="/settings">Account settings</Link>
          <SignOutButton variant="quiet" onFault={setFault} />
        </Cluster>
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
