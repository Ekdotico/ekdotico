// The feedback notice, on the server (FR-AU-95; register D505, D506, A109): the version of its text, whether an account
// has acknowledged the current one, and the record of an acknowledgement. Modelled on src/lib/closed-alpha-notice.ts.
//
// The text is the widget's notice for the state of the Discord switch, followed by the privacy link (src/lib/feedback/widget.ts).
// So the version follows the switch: 1 while posting to Discord is off, 2 while it is on, and turning posting on shows the
// notice once more (D506). Assumed, not stated in FR-AU-95: that the numbers are 1 and 2 and move with the switch.
import { db } from '../db.ts';
import { discordPostingOn } from './discord.ts';

/** The version of the notice for the state of the Discord switch. Raised whenever the fixed text changes (FR-AU-95). */
export function noticeVersion(discordPosting: boolean): 1 | 2 {
  return discordPosting ? 2 : 1;
}

/** Whether a recorded version covers the current one: nothing recorded, or a lower version, is shown the notice again. */
export function acknowledged(recorded: number | null, current: number): boolean {
  return recorded !== null && recorded >= current;
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
      OR: [{ feedbackNoticeVersion: null }, { feedbackNoticeVersion: { lt: version } }],
    },
    data: { feedbackNoticeVersion: version, feedbackNoticeAcknowledgedAt: new Date() },
  });
  return true;
}
