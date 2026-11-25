'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, usePathname } from 'next/navigation';
import { Button, Dialog, FormFault, RadioGroup, Stack, TextArea } from '@ekdotico/domico/components';
import { useReady } from '../../components/ready.ts';
import { NOT_READ, send, sendFor, type Fault } from '../../components/send.ts';
import {
  checkInput,
  clockTime,
  countOf,
  countText,
  noticeRefused,
  noticeText,
  sentText,
  outcomeOf,
  PRIVACY_HREF,
  rateLimitedText,
  remainingOf,
  retryId,
  routePattern,
  tooLongText,
  WIDGET_TEXT,
  type Attempt,
  type Faults,
  type Outcome,
} from '../../lib/feedback/widget.ts';
import { KINDS, MAX_MESSAGE_CODE_POINTS, type Kind } from '../../lib/feedback/validate.ts';

/**
 * The Feedback Widget (FR-AU-59 to FR-AU-80): one modal dialog, built from the package's own components and nothing else.
 * The header holds it once and opens it from whichever of its two controls is on screen. The dialog keeps its children
 * mounted, so a message half written survives Escape, and this component sits in the header, which stays when the page
 * changes, so it survives a change of page as well (FR-AU-80 (f)).
 *
 * Every sentence is one the owner approved, chosen by the code of the answer; the text the server writes beside its
 * codes is never shown (fw-refused-text). The browser checks first and the server decides (fw-refused-set).
 */

const CLOSE_ID = 'feedback-close';

/** The answer of a send, as the screen holds it. */
type Status =
  | { state: 'idle' }
  | { state: 'sending' }
  | { state: 'sent' }
  | { state: 'not_sent' }
  // `time` is worked out once, when the 429 arrives, so that a later render shows the same moment.
  | { state: 'rate_limited'; time: string };

/**
 * The feedback notice of FR-AU-95, as the dialog holds it. `idle` is not read yet, or is to be read again; the server's answer decides between `due`
 * (the notice, then "Continue") and `acknowledged` (the form). Never decided here: the browser only reads what the server says.
 */
type NoticeState =
  | { state: 'idle' }
  | { state: 'failed'; fault: Fault }
  | { state: 'due'; version: number; discordPosting: boolean; fault?: Fault }
  | { state: 'acknowledged'; discordPosting: boolean };

/**
 * The link to the privacy notice, in the notice before the form and in the notice above the send control. The owner's written
 * exception of 23 November 2026 to the rule that an internal link stays in the same tab: this one opens a new tab, so that a
 * half-written message is kept (FR-AU-80 (f)). The spoken words are the ones of the rule for external links.
 */
function PrivacyLink() {
  return (
    <a href={PRIVACY_HREF} target="_blank" rel="noopener noreferrer">
      {WIDGET_TEXT.privacyLink}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

const NOTICE_PATH = '/api/account/feedback-notice';
const CONTINUE_ID = 'feedback-notice-continue';

function noticeOf(answer: unknown): NoticeState | null {
  const found = answer as {
    currentVersion?: unknown;
    acknowledgedVersion?: unknown;
    discordPosting?: unknown;
  } | null;
  const version = found?.currentVersion;
  if (typeof version !== 'number' || typeof found?.discordPosting !== 'boolean') return null;
  const recorded = found.acknowledgedVersion;
  return typeof recorded === 'number' && recorded >= version
    ? { state: 'acknowledged', discordPosting: found.discordPosting }
    : { state: 'due', version, discordPosting: found.discordPosting };
}

export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ready = useReady();
  const [notice, setNotice] = useState<NoticeState>({ state: 'idle' });
  const [continuing, setContinuing] = useState(false);
  const acknowledging = useRef(false);
  const reading = useRef(false);
  const pathname = usePathname();
  const params = useParams<Record<string, string | string[]>>();
  const [kind, setKind] = useState<Kind | null>(null);
  const [message, setMessage] = useState('');
  const [faults, setFaults] = useState<Faults>({});
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  // The form is keyed so that it is cleared after a send, and only then (FR-AU-80 (f)).
  const [form, setForm] = useState(0);
  const attempt = useRef<Attempt | null>(null);
  // Read when the widget is opened (FR-AU-68 (a), (d)): where it was opened from, and the window then.
  const context = useRef<{ route: string; viewport: { width: number; height: number } } | null>(null);
  const first = useRef<HTMLElement | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const wasOpen = useRef(false);

  // The first radio is the first field, and where focus lands on opening (FR-AU-80 (b)).
  useEffect(() => {
    first.current = document.getElementById('feedback-kind');
  }, []);
  // A statement of "sent" is read once; the next opening shows the form.
  const dismiss = () => {
    if (status.state === 'sent') setStatus({ state: 'idle' });
    // A failed read is tried again at the next opening.
    if (notice.state === 'failed') setNotice({ state: 'idle' });
    onClose();
  };

  // FR-AU-95: whether the notice is due is read from the server when the dialog is opened, and again where a read failed or
  // a send was refused for it. Closing before "Continue" records nothing, so a notice still due is shown at the next opening.
  useEffect(() => {
    if (!open || notice.state !== 'idle' || reading.current) return;
    reading.current = true;
    sendFor(NOTICE_PATH, undefined, 'GET').then((result) => {
      reading.current = false;
      if ('fault' in result) return setNotice({ state: 'failed', fault: result.fault });
      setNotice(
        noticeOf(result.answer) ?? { state: 'failed', fault: { code: 'not_read', message: NOT_READ } },
      );
    });
  }, [open, notice.state]);

  // Focus follows what is shown (FR-AU-80 (b)): "Continue" while the notice is, the first kind once the form is.
  useEffect(() => {
    if (!open || status.state === 'sent') return;
    if (notice.state === 'due') document.getElementById(CONTINUE_ID)?.focus();
    else if (notice.state === 'acknowledged') document.getElementById('feedback-kind')?.focus();
  }, [open, notice.state, status.state]);

  async function acknowledge() {
    if (notice.state !== 'due' || acknowledging.current) return;
    acknowledging.current = true;
    setContinuing(true);
    const { version, discordPosting } = notice;
    const fault = await send('/api/account/feedback-notice/acknowledgement', { version });
    acknowledging.current = false;
    setContinuing(false);
    // A 409 means the text changed since it was read: read it again, and show the new one.
    if (fault?.code === 'notice_version_not_current') return setNotice({ state: 'idle' });
    setNotice(
      fault ? { state: 'due', version, discordPosting, fault } : { state: 'acknowledged', discordPosting },
    );
  }

  useEffect(() => {
    if (open && !wasOpen.current) {
      context.current = {
        route: routePattern(pathname, params ?? {}),
        viewport: {
          width: Math.min(Math.max(Math.round(window.innerWidth), 1), 32_767),
          height: Math.min(Math.max(Math.round(window.innerHeight), 1), 32_767),
        },
      };
    }
    wasOpen.current = open;
  }, [open, pathname, params]);

  // After a send the form is gone, and focus goes to the Close button.
  const focusFirst = () => document.getElementById('feedback-kind')?.focus();
  useEffect(() => {
    if (status.state === 'sent') document.getElementById(CLOSE_ID)?.focus();
  }, [status.state]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (status.state === 'sending' || !context.current) return;
    const found = checkInput(kind, message);
    setFaults(found);
    if (found.kind || found.message) {
      // The first field with a fault takes the focus, and its text is read with it (FR-AU-80 (d)).
      (found.kind ? focusFirst : () => area.current?.focus())();
      return;
    }
    const chosen = kind as Kind;
    const text = message.trim();
    setStatus({ state: 'sending' });
    let outcome: Outcome;
    try {
      const sentId = retryId(attempt.current, chosen, message);
      const response = await fetch('/api/feedback', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: chosen,
          message: text,
          route: context.current.route,
          viewport: context.current.viewport,
          ...(sentId ? { submissionId: sentId } : {}),
        }),
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // An answer that cannot be read is not an acceptance.
      }
      // The server's own refusal for a notice not yet acknowledged (FR-AU-95): the notice is read again, and shown.
      if (noticeRefused(response.status, body)) {
        setNotice({ state: 'idle' });
        setStatus({ state: 'idle' });
        return;
      }
      outcome = outcomeOf(response.status, body);
    } catch {
      // No answer: offline, or none in time. The same sentence as any other answer that is not an acceptance (FR-AU-77).
      outcome = { kind: 'not_sent' };
    }
    if (outcome.kind === 'sent') {
      attempt.current = null;
      setKind(null);
      setMessage('');
      setFaults({});
      setForm((n) => n + 1);
      setStatus({ state: 'sent' });
    } else if (outcome.kind === 'faults') {
      setFaults(outcome.faults);
      setStatus({ state: 'idle' });
      (outcome.faults.kind ? focusFirst : () => area.current?.focus())();
    } else if (outcome.kind === 'rate_limited') {
      // Nothing was attempted, so no identifier is kept, and the text stays.
      attempt.current = null;
      setStatus({ state: 'rate_limited', time: clockTime(outcome.retryAfterSeconds, new Date()) });
    } else {
      attempt.current = outcome.submissionId
        ? { submissionId: outcome.submissionId, kind: chosen, message: text }
        : null;
      setStatus({ state: 'not_sent' });
    }
  }

  const sent = status.state === 'sent';
  const messageFault =
    faults.message === 'empty'
      ? WIDGET_TEXT.empty
      : faults.message === 'forbidden_character'
        ? WIDGET_TEXT.refusedCharacter
        : faults.message === 'too_long'
          ? tooLongText(-remainingOf(message))
          : undefined;

  return (
    // No `closeLabel`: the dialog's own way out is the visible "Close" button below, in the form and on the statement
    // (fw-close-control), as the package says a dialog without a header button owes.
    <Dialog open={open} onClose={dismiss} title={WIDGET_TEXT.title} initialFocusRef={first}>
      {/* FR-AU-80 (e): the statement that it was sent stays until the reader closes it, announced where it appears. */}
      <div role="status">
        {sent ? (
          <FormFault announce="off" tone="neutral" autoFocus={false}>
            <p>{sentText(notice.state === 'acknowledged' && notice.discordPosting)}</p>
          </FormFault>
        ) : null}
      </div>
      {/* FR-AU-95: the feedback notice, before the kind and the message. Announced where it appears, as the statement above is.
          "Continue" records that it was shown and is not a consent: no tick box. Closing before it records nothing. */}
      <div role="status">
        {notice.state === 'due' ? (
          <p>
            {noticeText(notice.discordPosting)} <PrivacyLink />
          </p>
        ) : null}
      </div>
      {notice.state === 'failed' || (notice.state === 'due' && notice.fault) ? (
        <FormFault
          title={(notice.state === 'failed' ? notice.fault : notice.fault!).message}
          autoFocus={false}
        />
      ) : null}
      {notice.state === 'due' ? (
        <Stack gap={5}>
          <Button
            id={CONTINUE_ID}
            variant="primary"
            disabled={!ready}
            pending={continuing}
            pendingLabel="Continuing…"
            onClick={acknowledge}
          >
            Continue
          </Button>
        </Stack>
      ) : null}
      <form
        key={form}
        method="post"
        noValidate
        hidden={sent || notice.state !== 'acknowledged'}
        onSubmit={submit}
        aria-busy={status.state === 'sending' || undefined}
      >
        <Stack gap={5}>
          <RadioGroup
            id="feedback-kind"
            name="kind"
            legend={WIDGET_TEXT.legend}
            required
            value={kind ?? ''}
            onChange={(value) => {
              setKind(value as Kind);
              setFaults((current) => ({ ...current, kind: undefined }));
            }}
            error={faults.kind ? WIDGET_TEXT.noKind : undefined}
            options={KINDS.map((value) => ({ value, label: WIDGET_TEXT.kinds[value] }))}
          />
          <TextArea
            ref={area}
            id="feedback-message"
            name="message"
            label={WIDGET_TEXT.label}
            rows={6}
            maximum={MAX_MESSAGE_CODE_POINTS}
            // The server counts code points after the white space at both ends (fw-count-unit): `count` measures the
            // value so, and the number shown, the invalid state and the announcement all follow it.
            count={countOf}
            remainingLabel={countText}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              setFaults((current) => ({ ...current, message: undefined }));
            }}
            required
            hint={
              <>
                {noticeText(notice.state === 'acknowledged' && notice.discordPosting)} <PrivacyLink />
              </>
            }
            error={messageFault}
          />
          {status.state === 'not_sent' ? (
            <FormFault autoFocus={false}>
              <p>{WIDGET_TEXT.notSent}</p>
            </FormFault>
          ) : null}
          {status.state === 'rate_limited' ? (
            <FormFault autoFocus={false}>
              <p>{rateLimitedText(status.time)}</p>
            </FormFault>
          ) : null}
          <Button
            variant="primary"
            type="submit"
            disabled={!ready}
            pending={status.state === 'sending'}
            pendingLabel={WIDGET_TEXT.sending}
          >
            {WIDGET_TEXT.send}
          </Button>
        </Stack>
      </form>
      <Stack gap={5}>
        <Button id={CLOSE_ID} variant="quiet" onClick={dismiss}>
          {WIDGET_TEXT.close}
        </Button>
      </Stack>
    </Dialog>
  );
}
