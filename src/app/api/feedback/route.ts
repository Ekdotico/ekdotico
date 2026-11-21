// FR-AU-74 to FR-AU-78: the one request the Feedback Widget makes (API design, "Feedback intake";
// docs/contracts/feedback-intake.md). The work is in src/lib/feedback/submit.ts, which takes what it needs from
// here so that its rules are tested without a database. Closed while FEEDBACK_INTAKE_ENABLED is off.
import { randomUUID } from 'node:crypto';
import pkg from '../../../../package.json';
import { feedbackIntakeEnabled } from '../../../lib/account/feedback-step.ts';
import { fault, notAdmitted, refusedOrigin } from '../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../lib/auth/session.ts';
import { deliver } from '../../../lib/feedback/client.ts';
import { handleFeedback } from '../../../lib/feedback/submit.ts';
import { readJson } from '../../../lib/http.ts';
import { onboardingDue } from '../../../lib/onboarding.ts';
import { checkLimit, logLimitReached, takeLimit } from '../../../lib/rate-limit.ts';

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
        return { userId: null, stopped: validation.stopped ? await notAdmitted(validation) : null };
      },
      noticeAcknowledged: async (userId) => !(await onboardingDue(userId)),
      checkLimit,
      takeLimit,
      limitReached: (name, userId, seconds) => logLimitReached(name, userId, seconds, userId),
      readJson,
      deliver: (body) => deliver(body),
      appVersion: pkg.version,
      now: () => new Date(),
      newId: randomUUID,
      log: (line) => console.info(line),
    });
  } catch (error) {
    return fault('feedback', error);
  }
}
