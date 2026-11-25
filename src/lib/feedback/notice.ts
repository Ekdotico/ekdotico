// The feedback notice, on the server (FR-AU-95; register D505, D506, A109): the version of its text, whether an account
// has acknowledged the current one, and the record of an acknowledgement. Modelled on src/lib/closed-alpha-notice.ts.
//
// The text is the widget's notice for the state of the Discord switch, followed by the privacy link (src/lib/feedback/widget.ts).
// Each of the two texts has a version number of its own (D508, "on any change"), and an account is shown the notice again
// whenever its recorded version differs from the version of the text now shown. So turning posting on shows it once more, and
// turning it off again shows the off-text once more.
import { db } from '../db.ts';
import { discordPostingOn } from './discord.ts';

/**
 * The version of each of the two texts of the notice (D508). Raised by hand, and only when that text's wording changes: the
 * next free number is the next one, and a number is never reused for another text. Today: posting off 1, posting on 2; a
 * rewording of either takes 3, then 4. The numbers are not compared for order, only for equality.
 */
export const NOTICE_VERSIONS = { off: 1, on: 2 } as const;

/** The version of the notice for the state of the Discord switch. */
export function noticeVersion(discordPosting: boolean): number {
  return discordPosting ? NOTICE_VERSIONS.on : NOTICE_VERSIONS.off;
}

/** Whether the account has acknowledged the text now shown: nothing recorded, or any other version, is shown the notice again. */
export function acknowledged(recorded: number | null, current: number): boolean {
  return recorded === current;
}

/** What `GET /api/account/feedback-notice` reports. */
export interface FeedbackNoticeState {
  currentVersion: number;
  /** Null where the account has acknowledged no version. */
  acknowledgedVersion: number | null;
  acknowledgedAt: Date | null;
  /** Which text the version stands for: the widget shows the notice of D503 where true, that of FR-AU-72 where false. */
  discordPosting: boolean;
}

export async function feedbackNotice(userId: string): Promise<FeedbackNoticeState> {
  const discordPosting = discordPostingOn();
  const user = await db().user.findUnique({
    where: { id: userId },
    select: { feedbackNoticeVersion: true, feedbackNoticeAcknowledgedAt: true },
  });
  return {
    currentVersion: noticeVersion(discordPosting),
    acknowledgedVersion: user?.feedbackNoticeVersion ?? null,
    acknowledgedAt: user?.feedbackNoticeAcknowledgedAt ?? null,
    discordPosting,
  };
}

/** Whether the account is still to be shown the notice. Due where nothing can be read of the account. */
export async function feedbackNoticeDue(userId: string): Promise<boolean> {
  const { acknowledgedVersion, currentVersion } = await feedbackNotice(userId);
  return !acknowledged(acknowledgedVersion, currentVersion);
}

/**
 * Records the acknowledgement with the server's time, only for the current version: any other is `false` and nothing is
 * written. Repeated for the version already recorded it changes nothing, the time included.
 */
export async function acknowledgeFeedbackNotice(userId: string, version: unknown): Promise<boolean> {
  if (typeof version !== 'number' || version !== noticeVersion(discordPostingOn())) return false;
  await db().user.updateMany({
    where: {
      id: userId,
      // A null is not "different" to the database, so it is named; a version that already is the current one is not written.
      OR: [{ feedbackNoticeVersion: null }, { feedbackNoticeVersion: { not: version } }],
    },
    data: { feedbackNoticeVersion: version, feedbackNoticeAcknowledgedAt: new Date() },
  });
  return true;
}
