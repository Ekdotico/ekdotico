// FR-AU-74 to FR-AU-78: the one request the Feedback Widget makes (API design, "Feedback intake";
// docs/contracts/feedback-intake.md). The work is in src/lib/feedback/submit.ts, which takes what it needs from
// here so that its rules are tested without a database. Closed while FEEDBACK_INTAKE_ENABLED is off.
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import pkg from '../../../../package.json';
import { feedbackIntakeEnabled } from '../../../lib/account/feedback-step.ts';
import { inDeletion } from '../../../lib/account/in-deletion.ts';
import { fault, notAdmitted, refusedOrigin, unauthenticated } from '../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../lib/auth/session.ts';
import { closedAlphaNoticeDue } from '../../../lib/closed-alpha-notice.ts';
import { deliverOutcome } from '../../../lib/feedback/client.ts';
import { discordPostingOn, postToDiscord } from '../../../lib/feedback/discord.ts';
import { feedbackNoticeDue } from '../../../lib/feedback/notice.ts';
import { handleFeedback } from '../../../lib/feedback/submit.ts';
import { readJson } from '../../../lib/http.ts';
import { logLimitReached, takeLimitReturnable } from '../../../lib/rate-limit.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    // NFR-SE-17 (c): the origin first, as the test of every handler that changes state requires. The switch
    // follows at once: a request from this origin finds the route closed (404) while it is off.
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
    return await handleFeedback(request, {
      enabled: feedbackIntakeEnabled,
      session: async (headers) => {
        const validation = await validateSessionRow(headers);
        if (validation.session) return { userId: validation.session.userId };
        return { userId: null, denied: await notAdmitted(validation) };
      },
      noticeAcknowledged: async (userId) => !(await closedAlphaNoticeDue(userId)),
      feedbackNoticeAcknowledged: async (userId) => !(await feedbackNoticeDue(userId)),
      // FR-AU-94: after the response, so that the post neither delays nor changes the answer. `after` exists only inside a
      // request of the framework, and nothing is scheduled while posting is off.
      accepted: (submission) => {
        if (discordPostingOn()) after(() => postToDiscord(submission));
      },
      reserve: takeLimitReturnable,
      stillAllowed: async (userId) => ((await inDeletion(userId)) ? unauthenticated() : null),
      limitReached: (name, userId, seconds) => logLimitReached(name, userId, seconds, userId),
      readJson,
      deliver: (body) => deliverOutcome(body),
      appVersion: pkg.version,
      now: () => new Date(),
      newId: randomUUID,
      log: (line) => console.info(line),
    });
  } catch (error) {
    return fault('feedback', error);
  }
}
