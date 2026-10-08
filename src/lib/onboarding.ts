// The onboarding wizard's one step, the Closed α notice, on the server
// (FR-AU-55, FR-AU-56): its fixed text, its version, whether an account is
// still to be shown it, and the record of an acknowledgement. Nothing here is
// of Next.js. The wizard gates pages and not API routes (API design, "Paths
// without a session"), so no route asks `onboardingDue`.
import { db } from './db.ts';

/**
 * FR-AU-56: the version of the notice. It "starts at 1 and is raised whenever
 * its fixed text changes", and an account whose recorded version is lower is
 * shown the wizard once more. Two changes are already foreseen: the sentence
 * on feedback, added with the Feedback Widget, where whether the version is
 * raised "is decided then" (register D111); and the sentence with the contact
 * address, added before the first test user is admitted (FR-AU-55).
 */
export const CLOSED_ALPHA_NOTICE_VERSION = 1;

/** FR-AU-55: the fixed title, verbatim. */
export const CLOSED_ALPHA_NOTICE_TITLE = 'Closed α';

/**
 * FR-AU-55: the fixed body, verbatim, as a release without the Feedback Widget
 * shows it (register D111) and while there is no contact address: the first
 * six sentences. Left out are "To send feedback, choose Send feedback at the
 * top of any page." and "To reach the Ekdotico team, write to [contact address]."
 */
export const CLOSED_ALPHA_NOTICE_BODY =
  'Ekdotico is in Closed α. Closed α is an early test release. Only invited people can create an account. This release does not reflect the planned first public version of Ekdotico. It may be unavailable at times, and the Ekdotico team makes no commitment about its availability. The Ekdotico team uses feedback from the people who test this release to design and develop the next steps.';

/** What `GET /api/account/onboarding` reports (API design, "Account"). */
export interface Onboarding {
  currentVersion: number;
  /** Null where the account has acknowledged no version. */
  acknowledgedVersion: number | null;
  acknowledgedAt: Date | null;
}

export async function onboarding(userId: string): Promise<Onboarding> {
  const user = await db().user.findUnique({
    where: { id: userId },
    select: { closedAlphaNoticeVersion: true, closedAlphaNoticeAcknowledgedAt: true },
  });
  return {
    currentVersion: CLOSED_ALPHA_NOTICE_VERSION,
    acknowledgedVersion: user?.closedAlphaNoticeVersion ?? null,
    acknowledgedAt: user?.closedAlphaNoticeAcknowledgedAt ?? null,
  };
}

/**
 * FR-AU-55, FR-AU-56: whether the wizard is shown in place of a page. Due
 * where the account has acknowledged nothing, or a version lower than the
 * current one; and due where nothing can be read of the account.
 */
export async function onboardingDue(userId: string): Promise<boolean> {
  const { acknowledgedVersion } = await onboarding(userId);
  return !(acknowledgedVersion !== null && acknowledgedVersion >= CLOSED_ALPHA_NOTICE_VERSION);
}

/**
 * FR-AU-56: records the acknowledgement of this account, with the server's
 * time. Accepted "only for the current version": any other is `false`, and
 * nothing is written. Repeated for the version already recorded it changes
 * nothing, the time included: the one statement writes only where the recorded
 * version is absent or lower, so two requests at once record one time.
 */
export async function acknowledgeNotice(userId: string, version: unknown): Promise<boolean> {
  if (version !== CLOSED_ALPHA_NOTICE_VERSION) return false;
  await db().user.updateMany({
    where: {
      id: userId,
      OR: [{ closedAlphaNoticeVersion: null }, { closedAlphaNoticeVersion: { lt: version } }],
    },
    data: { closedAlphaNoticeVersion: version, closedAlphaNoticeAcknowledgedAt: new Date() },
  });
  return true;
}
