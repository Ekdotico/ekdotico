// Settings read from the environment when a process starts. The web application
// and the collaboration server both load them through this one module
// (NFR-SE-17 (f)). Every secret is read here and nowhere else (NFR-SE-19).
import { isIP } from 'node:net';
import { acceptedAddress } from './field-text.ts';
import { checkInUrl } from './healthcheck.ts';

/**
 * `COLLAB_HOST`: a specific IP address, 127.0.0.1 where unset or empty. A name is refused, since it could resolve
 * to every interface, and so are the unspecified addresses, which are every interface.
 */
function collabHost(env: Record<string, string | undefined>): string {
  const host = env.COLLAB_HOST || '127.0.0.1';
  // An IPv6 address in its one canonical form, whatever its spelling: `::`, `0:0:0:0:0:0:0:0`, and the
  // IPv4-mapped `::ffff:0.0.0.0` (which is `::ffff:0:0`) are all the unspecified address. A zone (`%eth0`) is dropped.
  const bare = host.split('%')[0]!;
  const canonical = isIP(bare) === 6 ? new URL(`http://[${bare}]`).hostname : bare;
  if (!isIP(bare) || ['0.0.0.0', '[::]', '[::ffff:0:0]'].includes(canonical)) {
    throw new Error(
      'COLLAB_HOST must be a specific IP address, such as 127.0.0.1; a name, 0.0.0.0, :: and ::ffff:0.0.0.0 would listen on every interface. The web application and the collaboration server both read it, so a bad value stops both.',
    );
  }
  return host;
}

/** A limit of NFR-SE-07: at most `max` in any `windowSeconds`. */
export interface Limit {
  max: number;
  windowSeconds: number;
}

// The initial values of NFR-SE-07, for the rows of α 0.1.0. Each is changed
// without a code change by the variable RATE_LIMIT_<NAME>, written `max/seconds`.
const LIMITS = {
  /** Requests to API routes, for each authenticated user. */
  API_PER_USER: [120, 60],
  /** Invitations created, for each authenticated user. */
  INVITATIONS_PER_USER: [20, 3600],
  /** Offers of ownership made, for each authenticated user (the owner's decision S17-7: 20 in an hour, as invitations). */
  OFFERS_PER_USER: [20, 3600],
  /** Image uploads, for each authenticated user. */
  IMAGE_UPLOADS_PER_USER: [30, 600],
  /** Draft exports started, for each authenticated user. */
  EXPORTS_PER_USER: [10, 3600],
  /** Collaboration handshakes, for each authenticated user. */
  HANDSHAKES_PER_USER: [30, 60],
  /** Requests to the session-less pages and endpoints, for each network address. */
  SESSIONLESS_PER_ADDRESS: [20, 60],
  /** Failed sign-ins, for one email address from one network address. */
  FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS: [5, 900],
  /** Failed sign-ins, for one email address from all network addresses. */
  FAILED_SIGN_IN_PER_EMAIL: [20, 3600],
  /** Password-reset requests, for each email address entered. */
  RESET_PER_EMAIL: [3, 3600],
  /** Password-reset requests, for each network address. */
  RESET_PER_ADDRESS: [10, 3600],
  /** Confirmation email for a changed address, for each authenticated user. */
  CONFIRMATION_EMAIL_PER_USER: [3, 3600],
  /** Requests to the admission endpoints, in all. */
  ADMISSION: [60, 60],
  /**
   * Messages that carry an update of a document, for each authenticated user
   * on one collaboration server. No row of NFR-SE-07 yet: the owner's decision
   * of 12 October 2026, to be added by amendment. Counted in the memory of the
   * instance (`limitHere` of src/lib/rate-limit.ts says why).
   */
  COLLAB_MESSAGES_PER_USER: [600, 60],
} as const satisfies Record<string, readonly [number, number]>;

export type LimitName = keyof typeof LIMITS;

/** The object store of the images (NFR-SE-18). The two secrets are read here and nowhere else (NFR-SE-19). */
export interface ImageStorageSettings {
  /** The origin of the store's API: `https://fra1.digitaloceanspaces.com`, or `http://localhost:8333` on a development machine. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Whether the bucket is in the path of an address (a store on this machine) and not in its host (Spaces). */
  pathStyle: boolean;
  /**
   * The one origin an image is loaded from, which the policy of a page names in `img-src` and nowhere
   * else (the owner's decision of 20 October 2026, S19-4): the origin of a link as the store writes it.
   */
  origin: string;
}

export interface Settings {
  /** The founding team's addresses, lower case (FR-AU-83; register D114, A102). */
  foundingTeamEmails: readonly string[];
  /** The application's own origin, the one entry of the allow-list of NFR-SE-17 (c). */
  appOrigin: string;
  /** The connection string of the runtime role, `ekdotico_app` (NFR-IC-17). */
  databaseUrl: string;
  valkeyUrl: string;
  /** The identity library's secret; it also encrypts the second factor at rest (NFR-SE-17 (a), (e)). */
  authSecret: string;
  /** How many proxies stand between a client and this process (the owner's answer to Q5): 1 or more away from localhost. */
  trustedProxyCount: number;
  /** FR-AU-84: both periods of a session, and the renewal interval. */
  sessionIdleSeconds: number;
  sessionRenewSeconds: number;
  sessionMaxSeconds: number;
  /** NFR-SE-17 (c): the lifetime of the signed copy of a session. */
  cookieCacheSeconds: number;
  /**
   * FR-AU-82: the two limits on the length of a password. The initial values, 8
   * and 32, are the owner's decision of 8 October 2026; the requirement says 15
   * and 128 until the Docs are amended.
   */
  passwordMinLength: number;
  passwordMaxLength: number;
  /** FR-AU-82: the list of commonly used and known-compromised passwords, a file read on the server. */
  passwordListFile: string;
  /**
   * FR-AU-83: "The second step is completed within 10 minutes of the password
   * (an initial value), or the sign-in begins again." The secret of an
   * enrolment waits as long for its first code (two-factor.ts).
   */
  secondStepSeconds: number;
  /**
   * NFR-SE-07, "Wrong second-factor codes, for each sign-in": 5, an initial
   * value. The wrong code that reaches the number abandons the sign-in, and
   * at the first code of an enrolment, the enrolment.
   */
  secondStepWrongCodes: number;
  /**
   * FR-AU-81, NFR-SE-07: how long the twentieth failed sign-in locks an
   * account, "1 hour", an initial value (register D115: "both figures are
   * settings"; the other is the limit FAILED_SIGN_IN_PER_EMAIL). The sign-in
   * link of the lock's email is valid as long.
   */
  signInLockSeconds: number;
  /**
   * FR-AU-89: the key of the signed admission requests, or none. Without it
   * every admission request is refused. The name and the form are provisional
   * (docs/contracts/admission-signature.md).
   */
  admissionSecret: string | undefined;
  /** FR-AU-89 (a): how long an admission invitation stays open. */
  admissionInvitationDays: number;
  /** FR-ED-37: how long a document invitation stays pending, "14 days … (an initial value)". */
  documentInvitationDays: number;
  /** FR-ED-48: how long before its expiry an invitation is reminded, "3 days … (an initial value)". */
  invitationReminderDays: number;
  /** FR-ED-37: how long after it ended the address of a declined, revoked, or expired invitation is kept, "30 days (an initial value)". */
  documentInvitationAddressDays: number;
  /** FR-ED-47: how long an offer of ownership stays pending, "14 days … (an initial value)". */
  ownershipOfferDays: number;
  /**
   * FR-AU-91: how long a shared document waits between the confirmation of a clearing and its deletion, "7 days
   * (an initial value, and a setting)". It is the notice its collaborators are given to take a copy.
   */
  clearingNoticeDays: number;
  /** NFR-SE-19: how long a security log entry is kept. */
  securityLogRetentionDays: number;
  /** FR-ED-36: how long a deleted document is retained, and can be restored, before it is deleted permanently. */
  deletedDocumentRetentionDays: number;
  /**
   * NFR-SE-18: the most a document holds of images, "100 MB (an initial value)", in bytes. Every stored
   * object counts, one taken out of the document included until it is deleted (the owner's answer to Q14).
   */
  imageDocumentBytes: number;
  /** NFR-SE-18: how long an image that no longer appears in its document is kept, "30 days (an initial value)". */
  imageUnreferencedDays: number;
  /** NFR-SE-18: how long a link to an image is valid, "5 minutes (an initial value)", in seconds. */
  imageLinkSeconds: number;
  /**
   * Where the images are stored: DigitalOcean Spaces in FRA1 in production, a local S3-compatible store on
   * a development machine (the owner's decision of 20 October 2026, S19-1). Absent where none of its
   * settings is given, and then no image can be uploaded or shown.
   */
  imageStorage: ImageStorageSettings | undefined;
  /** Where email goes (register D262): the local sink, which writes each message to a file, or Brevo. */
  emailTransport: 'sink' | 'brevo';
  /** Where the local sink writes each message. Not required with Brevo, which writes no file. */
  emailSinkDirectory: string;
  /** The address messages are sent from. */
  emailFrom: string;
  /** `emailFrom` as a name and an address: set with Brevo, which needs both, and undefined with the sink. */
  emailSender: EmailSender | undefined;
  /** The key of the Brevo account: set with Brevo, undefined with the sink. Read here and nowhere else (NFR-SE-19). */
  brevoApiKey: string | undefined;
  /**
   * NFR-RE-07 (register P14): the collaboration server stores a document's
   * state no later than the first after the last change it received, and at
   * least as often as the second while changes continue. Milliseconds; the
   * initial values are 2 and 10 seconds.
   */
  collabStoreDelayMs: number;
  collabStoreMaxMs: number;
  /**
   * FR-ED-23: how long the editor tries to restore a lost connection before
   * the sync status indicator shows its error state. Milliseconds; the initial
   * value is 30 seconds. The page hands it to the editor.
   */
  collabErrorAfterMs: number;
  /**
   * The address the collaboration server listens on (docs/operations/deployment.md, item 8: it is reached only
   * through the proxy). The loopback address unless `COLLAB_HOST` names another, which must be an IP address.
   */
  collabHost: string;
  /**
   * FR-ED-41: how often the collaboration server reads again the session and
   * the access of every open connection, "at least once every 60 seconds".
   * Milliseconds, from 1000 to 60000, and 60 seconds where unset: a longer period would not be what the requirement asks, and a shorter one makes the re-check a load of its own.
   */
  collabRecheckMs: number;
  /**
   * FR-EX-36: "A response that has sent nothing for 30 seconds is aborted (an initial value)": the Markdown draft
   * export ends its response, and releases the lock of its user, when that long passes with no progress.
   */
  exportIdleSeconds: number;
  /** FR-EX-36: a name derived from a title "is cut to 100 characters (an initial value)". */
  exportNameMaxChars: number;
  /** D275: the ping address of the check of the application's timers. Absent: nothing is called. */
  healthcheckTimersUrl: string | undefined;
  /** D274, D320: the ping address of the check of email health. Absent: nothing is called. */
  healthcheckEmailUrl: string | undefined;
  limits: Readonly<Record<LimitName, Limit>>;
}

type Env = Record<string, string | undefined>;

/** The sender of an email: `Ekdotico <no-reply@ekdoti.co>` as a name and an address. */
export interface EmailSender {
  name: string;
  email: string;
}

// A name, then the address in angle brackets. The name holds none of the characters that would end it early
// or add a header, and the address is held to the one rule of an address (FR-AU-02).
function emailSender(from: string): EmailSender | undefined {
  const match = /^([^<>"\r\n]+?)\s*<([^<>\s]+)>$/.exec(from.trim());
  const email = match && acceptedAddress(match[2]);
  return email ? { name: match[1]!.trim(), email } : undefined;
}

// The key goes into a header. A space or a line break at its end, as a pasted secret often has, makes the HTTP
// client refuse the header with a message that may quote it (NFR-SE-19), so it is refused here, without a word of it.
function brevoApiKey(env: Env): string {
  const key = required(env, 'BREVO_API_KEY', 'Set it to the API key of the Brevo account.');
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new Error('BREVO_API_KEY must be the key alone: no space, no line break.');
  }
  return key;
}

function required(env: Env, name: string, hint: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

// The least a value may be is 1 wherever 0 would switch a rule off without a
// word: a session that has ended before it began, a log that keeps nothing, a
// password of no length, an invitation that is never open.
function wholeNumber(env: Env, name: string, initial: number, least: 0 | 1): number {
  const value = env[name];
  if (value === undefined || value === '') return initial;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) < least) {
    throw new Error(`${name} must be a whole number, ${least} or more.`);
  }
  return Number(value);
}

function limit(env: Env, name: LimitName): Limit {
  const value = env[`RATE_LIMIT_${name}`];
  const [max, windowSeconds] = LIMITS[name];
  if (value === undefined || value === '') return { max, windowSeconds };
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(value);
  if (!match)
    throw new Error(`RATE_LIMIT_${name} must be written max/seconds, for example ${max}/${windowSeconds}.`);
  return { max: Number(match[1]), windowSeconds: Number(match[2]) };
}

// docs/contracts/admission-signature.md, "The setting": at least 43 characters
// of the URL-safe alphabet, used exactly as set.
function admissionSecret(env: Env): string | undefined {
  const value = env.ADMISSION_SECRET;
  if (value === undefined || value === '') return undefined;
  if (!/^[A-Za-z0-9_-]{43,}$/.test(value)) {
    throw new Error('ADMISSION_SECRET must be at least 43 characters of A to Z, a to z, 0 to 9, - and _.');
  }
  return value;
}

const STORAGE_NAMES = [
  'IMAGE_STORAGE_ENDPOINT',
  'IMAGE_STORAGE_BUCKET',
  'IMAGE_STORAGE_ACCESS_KEY_ID',
  'IMAGE_STORAGE_SECRET_ACCESS_KEY',
] as const;

/**
 * The settings of the object store, or none. All of them or none: with some
 * given and others not, the process does not start, so that a deployment does
 * not lose its images by a name misspelt. With none, no image can be uploaded
 * or shown (the routes answer 503, and the policy of a page names no origin
 * beside its own); a deployment says so at start, when it is not on
 * localhost (src/instrumentation.ts). The message holds the names and never a
 * value (NFR-SE-19).
 */
function imageStorage(env: Env, secrets: readonly (string | undefined)[]): ImageStorageSettings | undefined {
  const given = STORAGE_NAMES.filter((name) => env[name]);
  if (given.length === 0) return undefined;
  const absent = STORAGE_NAMES.filter((name) => !env[name]);
  if (absent.length > 0)
    throw new Error(
      `${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not set: the object store needs all four settings.`,
    );
  const endpoint = env.IMAGE_STORAGE_ENDPOINT!;
  if (!URL.canParse(endpoint) || new URL(endpoint).origin !== endpoint) {
    throw new Error(
      'IMAGE_STORAGE_ENDPOINT must be an origin: a scheme, a host and an optional port, with nothing after.',
    );
  }
  const { protocol, hostname, host } = new URL(endpoint);
  const here = ['localhost', '127.0.0.1'].includes(hostname);
  if (protocol !== 'https:' && !(protocol === 'http:' && here)) {
    throw new Error('IMAGE_STORAGE_ENDPOINT must use https, except on localhost.');
  }
  const bucket = env.IMAGE_STORAGE_BUCKET!;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(
      'IMAGE_STORAGE_BUCKET must be a bucket name: 3 to 63 characters of a to z, 0 to 9 and -.',
    );
  }
  const region = env.IMAGE_STORAGE_REGION || 'fra1';
  if (!/^[a-z0-9-]{2,32}$/.test(region))
    throw new Error('IMAGE_STORAGE_REGION must be 2 to 32 characters of a to z, 0 to 9 and -.');
  const secretAccessKey = env.IMAGE_STORAGE_SECRET_ACCESS_KEY!;
  // NFR-SE-17 (e): the secrets differ from one another, so that one that leaks opens one door.
  if (secrets.includes(secretAccessKey)) {
    throw new Error('IMAGE_STORAGE_SECRET_ACCESS_KEY must differ from the other secrets of the application.');
  }
  // A store on this machine has the bucket in the path; Spaces has it in the host, where the origin of a link is the bucket's.
  const pathStyle = here;
  return {
    endpoint,
    bucket,
    region,
    accessKeyId: env.IMAGE_STORAGE_ACCESS_KEY_ID!,
    secretAccessKey,
    pathStyle,
    origin: pathStyle ? endpoint : `${protocol}//${bucket}.${host}`,
  };
}

function imageLinkSeconds(env: Env): number {
  const seconds = wholeNumber(env, 'IMAGE_LINK_SECONDS', 300, 1);
  if (seconds > IMAGE_LINK_MOST_SECONDS) {
    throw new Error(`IMAGE_LINK_SECONDS must be no more than ${IMAGE_LINK_MOST_SECONDS}.`);
  }
  return seconds;
}

/** The longest a name derived from a title may be: a title is 200 characters (FR-ED-35), so a longer cut cuts nothing. */
const EXPORT_NAME_MOST_CHARS = 200;

// At least 1: a name of 0 characters would be `document` for every title.
function exportNameMaxChars(env: Env): number {
  const chars = wholeNumber(env, 'EXPORT_NAME_MAX_CHARS', 100, 1);
  if (chars > EXPORT_NAME_MOST_CHARS) {
    throw new Error(`EXPORT_NAME_MAX_CHARS must be no more than ${EXPORT_NAME_MOST_CHARS}.`);
  }
  return chars;
}

const DAY = 24 * 60 * 60;
const DELETED_DOCUMENT_RETENTION_MAX_DAYS = 3650;
/** The longest a link to an image may be valid: Signature Version 4 itself allows seven days; an hour is far more than the 5 minutes of NFR-SE-18. */
const IMAGE_LINK_MOST_SECONDS = 3600;
/** §2.7: the invited address of an invitation that ended is cleared 30 days after, the longest it may be kept. */
const DOCUMENT_INVITATION_ADDRESS_MAX_DAYS = 30;

/**
 * `sendsEmail` is true for the web application, which sends email, and false for the collaboration server, which
 * sends none: with Brevo chosen it then neither reads nor checks `BREVO_API_KEY` and `EMAIL_FROM`, so the key is
 * held by the one process that uses it (see `collabSettings`).
 */
export function loadSettings(env: Env = process.env, sendsEmail = true): Settings {
  // NFR-SE-17 (b), (c): the identity library also reads variables of its own,
  // which can switch its telemetry on and add trusted origins whatever the
  // application configures. Refused here, so that both processes refuse. The
  // message holds the names and never a value.
  const ofTheLibrary = Object.keys(env).filter((name) => name.startsWith('BETTER_AUTH_'));
  if (ofTheLibrary.length > 0) {
    throw new Error(
      `Unset ${ofTheLibrary.join(', ')}: the identity library is configured by the application alone.`,
    );
  }
  // NFR-SE-07: a limit written under a name that is none of the limits would
  // change nothing, and the deployment would believe it had.
  const noLimit = Object.keys(env).filter(
    (name) => name.startsWith('RATE_LIMIT_') && !Object.hasOwn(LIMITS, name.slice('RATE_LIMIT_'.length)),
  );
  if (noLimit.length > 0) {
    throw new Error(
      `Unset ${noLimit.join(', ')}: no limit has that name. The names are in src/lib/settings.ts.`,
    );
  }
  const list = env.FOUNDING_TEAM_EMAILS;
  // A102: a process refuses to start where the setting is absent, so that a
  // deployment cannot lose the two-factor requirement by losing the setting.
  // A list with no address is written as an empty value.
  if (list === undefined) {
    throw new Error(
      'FOUNDING_TEAM_EMAILS is not set. Set it to the founding team’s addresses, separated by commas, or to an empty value.',
    );
  }
  const appOrigin = required(env, 'APP_ORIGIN', 'Set it to the origin the application is served from.');
  if (!URL.canParse(appOrigin) || new URL(appOrigin).origin !== appOrigin) {
    throw new Error(
      'APP_ORIGIN must be an origin: a scheme, a host and an optional port, with nothing after.',
    );
  }
  // NFR-SE-17 (c): the session cookie is Secure, which needs HTTPS. Plain HTTP
  // is admitted for a development machine alone.
  const { protocol, hostname } = new URL(appOrigin);
  if (protocol !== 'https:' && !(protocol === 'http:' && ['localhost', '127.0.0.1'].includes(hostname))) {
    throw new Error('APP_ORIGIN must use https, except on localhost.');
  }
  // Two senders: the local sink, which writes each message to a file, and Brevo
  // (register D262). Anywhere but a development machine one has to be chosen in
  // so many words, so that no deployment loses its email unnoticed: sign-in and
  // reset answer the same whether or not a message went.
  const local = ['localhost', '127.0.0.1'].includes(hostname);
  // docs/operations/deployment.md, item 9: the web application passes `/collab`
  // to the collaboration server itself on a development machine alone
  // (next.config.ts). The build refuses the setting with an origin that is not
  // on localhost; a build made on localhost and started elsewhere is refused
  // here, and what such a build holds is refused by `refuseBuiltCollabRewrite`.
  if (!local && env.COLLAB_PROXY_TARGET) {
    throw new Error('COLLAB_PROXY_TARGET is for a development machine: unset it.');
  }
  const transport = env.EMAIL_TRANSPORT || (local ? 'sink' : undefined);
  // Away from a development machine only Brevo is admitted (register D270), and the message offers only that.
  if (transport !== 'sink' && transport !== 'brevo') {
    throw new Error(
      local ? 'EMAIL_TRANSPORT must be set to sink or brevo.' : 'EMAIL_TRANSPORT must be set to brevo.',
    );
  }
  // NFR-SE-19: each file of the sink holds an address and may hold a single-use
  // link, and a sink away from a development machine never gets a directory
  // under the working directory by leaving the setting out. The refusal of D270
  // is what such a deployment is told first, whatever else it has not set.
  // Brevo writes no file.
  if (transport === 'sink' && !local && !env.EMAIL_SINK_DIRECTORY) {
    throw new Error(SINK_REFUSED);
  }
  const emailFrom = env.EMAIL_FROM || 'Ekdotico <no-reply@localhost>';
  let sender: EmailSender | undefined;
  let brevoKey: string | undefined;
  if (transport === 'brevo' && sendsEmail) {
    brevoKey = brevoApiKey(env);
    if (!env.EMAIL_FROM) {
      throw new Error(
        'EMAIL_FROM is not set. Set it to the sender, in the form Ekdotico <no-reply@ekdoti.co>.',
      );
    }
    // A sender on a development machine is one Brevo cannot verify. Asked of the text before it is parsed,
    // since the rule of an address refuses a domain with no dot and the message would then say the wrong thing.
    if (/@([^@\s>]*\.)?localhost\s*>?\s*$/i.test(emailFrom)) {
      throw new Error('EMAIL_FROM must not use localhost with Brevo.');
    }
    sender = emailSender(emailFrom);
    if (!sender) {
      throw new Error('EMAIL_FROM must be a name and an address, in the form Ekdotico <no-reply@ekdoti.co>.');
    }
    // Brevo takes a name of 70 characters at most, and a domain: the rule of an address lets an IP address pass.
    if (sender.name.length > 70)
      throw new Error('EMAIL_FROM must have a name of no more than 70 characters.');
    if (/^[\d.]+$|[:[\]]/.test(sender.email.slice(sender.email.indexOf('@') + 1))) {
      throw new Error('EMAIL_FROM must be on a domain, not an IP address.');
    }
  }
  // NFR-SE-07; the owner's decision of 8 October 2026: the limits for each
  // network address need the address, and without a proxy that writes it there
  // is none to trust (docs/operations/deployment.md). With 0 every request
  // without a session shares one count, which one client can use up for
  // everyone: admitted on a development machine alone.
  const trustedProxyCount = wholeNumber(env, 'TRUSTED_PROXY_COUNT', 0, 0);
  if (!local && trustedProxyCount < 1) {
    throw new Error(
      'TRUSTED_PROXY_COUNT must be 1 or more, except on localhost: set it to the number of proxies in front of the process, the outermost of which writes the address of its peer. Without one, the limits for each network address count every client as one.',
    );
  }
  const authSecret = required(env, 'AUTH_SECRET', 'Set it to a random value of at least 32 characters.');
  if (authSecret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters.');
  // NFR-RE-07: the collaboration server takes the time of the write itself off
  // the first period, and the first period twice off the second
  // (src/collab/server.ts, `storeTimers`), so each has a least value.
  const collabStoreDelayMs = wholeNumber(env, 'COLLAB_STORE_DELAY_MS', 2000, 1);
  const collabStoreMaxMs = wholeNumber(env, 'COLLAB_STORE_MAX_MS', 10000, 1);
  if (collabStoreDelayMs < 1000) throw new Error('COLLAB_STORE_DELAY_MS must be at least 1000.');
  if (collabStoreMaxMs < 2 * collabStoreDelayMs + 1000) {
    throw new Error('COLLAB_STORE_MAX_MS must be at least twice COLLAB_STORE_DELAY_MS and 1000 more.');
  }
  // FR-ED-41: "at least once every 60 seconds", so never less often; and not so often that the re-check is a load of its own (a query for the sessions and one for each user and document, each run).
  const collabRecheckMs = wholeNumber(env, 'COLLAB_RECHECK_MS', 60_000, 1);
  if (collabRecheckMs > 60_000 || collabRecheckMs < 1000) {
    throw new Error('COLLAB_RECHECK_MS must be from 1000 to 60000 (FR-ED-41).');
  }
  // NFR-SE-17 (e): the secrets differ from one another, so that one that
  // leaks opens one door. The message holds neither.
  const admission = admissionSecret(env);
  if (admission === authSecret) throw new Error('ADMISSION_SECRET must differ from AUTH_SECRET.');
  // The key of Brevo goes to a third party in a header: one that was another secret by a slip of the paste
  // would give that secret to it. The message holds neither.
  if (
    brevoKey !== undefined &&
    [authSecret, admission, env.IMAGE_STORAGE_SECRET_ACCESS_KEY].includes(brevoKey)
  ) {
    throw new Error('BREVO_API_KEY must differ from the other secrets of the application.');
  }

  const sessionIdleSeconds = wholeNumber(env, 'SESSION_IDLE_SECONDS', 7 * DAY, 1);
  const sessionRenewSeconds = wholeNumber(env, 'SESSION_RENEW_SECONDS', DAY, 1);
  const sessionMaxSeconds = wholeNumber(env, 'SESSION_MAX_SECONDS', 30 * DAY, 1);
  // FR-AU-84: a renewal comes within the period it renews, and that period
  // within the life of a session. Written otherwise, one of the three would
  // never be reached.
  if (sessionRenewSeconds > sessionIdleSeconds || sessionIdleSeconds > sessionMaxSeconds) {
    throw new Error(
      'SESSION_RENEW_SECONDS must be no more than SESSION_IDLE_SECONDS, and SESSION_IDLE_SECONDS no more than SESSION_MAX_SECONDS.',
    );
  }
  const passwordMinLength = wholeNumber(env, 'PASSWORD_MIN_LENGTH', 8, 1);
  const passwordMaxLength = wholeNumber(env, 'PASSWORD_MAX_LENGTH', 32, 1);
  // FR-AU-82: otherwise no password could be chosen at all.
  if (passwordMinLength > passwordMaxLength) {
    throw new Error('PASSWORD_MIN_LENGTH must be no more than PASSWORD_MAX_LENGTH.');
  }
  const limits = Object.fromEntries(
    (Object.keys(LIMITS) as LimitName[]).map((name) => [name, limit(env, name)]),
  ) as Record<LimitName, Limit>;
  // At least 1: a lock of 0 seconds would be no lock, without a word.
  const signInLockSeconds = wholeNumber(env, 'SIGN_IN_LOCK_SECONDS', 3600, 1);
  // FR-AU-81, NFR-SE-07: the failures that caused a lock are still counted when
  // a shorter lock ends, so the next single failure would be "the twentieth"
  // again: a lock and an email for each failure, for the rest of the period.
  if (signInLockSeconds < limits.FAILED_SIGN_IN_PER_EMAIL.windowSeconds) {
    throw new Error(
      'SIGN_IN_LOCK_SECONDS must be no less than the seconds of RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL.',
    );
  }
  // FR-ED-36. At least 1: with 0 a deletion would be permanent at the next run
  // of the timer, and the confirmation would have promised a restore that is
  // not there. At most 3,650, ten years: the days are taken from the present
  // moment and added to the moment of a deletion, and past some 100,000,000 of
  // them the result is no date at all, which no query can be asked with. Ten
  // years is far inside that, and longer than "retained" can honestly mean.
  const deletedDocumentRetentionDays = wholeNumber(env, 'DELETED_DOCUMENT_RETENTION_DAYS', 30, 1);
  if (deletedDocumentRetentionDays > DELETED_DOCUMENT_RETENTION_MAX_DAYS) {
    throw new Error(
      `DELETED_DOCUMENT_RETENTION_DAYS must be no more than ${DELETED_DOCUMENT_RETENTION_MAX_DAYS}.`,
    );
  }

  // FR-ED-48: "3 days before the expiry". A reminder period as long as the
  // invitation's own would send the reminder within the hour, beside the
  // invitation's email, and a longer one would send none (S18-3), each without
  // a word: so neither starts.
  const documentInvitationDays = wholeNumber(env, 'DOCUMENT_INVITATION_DAYS', 14, 1);
  const invitationReminderDays = wholeNumber(env, 'INVITATION_REMINDER_DAYS', 3, 1);
  if (invitationReminderDays >= documentInvitationDays) {
    throw new Error('INVITATION_REMINDER_DAYS must be less than DOCUMENT_INVITATION_DAYS.');
  }
  // FR-ED-37 and §2.7 (the row "Document invitations, with the invited email address"): the address is
  // cleared 30 days after the invitation ended. A shorter period clears sooner, which the row allows; a
  // longer one would keep an address past the retention the schedule states, so it does not start.
  const documentInvitationAddressDays = wholeNumber(env, 'DOCUMENT_INVITATION_ADDRESS_DAYS', 30, 1);
  if (documentInvitationAddressDays > DOCUMENT_INVITATION_ADDRESS_MAX_DAYS) {
    throw new Error(
      `DOCUMENT_INVITATION_ADDRESS_DAYS must be no more than ${DOCUMENT_INVITATION_ADDRESS_MAX_DAYS} (§2.7).`,
    );
  }

  // The owner's decision of 9 October 2026: an entry that no account can have
  // as its address (src/lib/field-text.ts) matches none, and the account it
  // was meant for would be exempt from the gate without a word. The message
  // says which entry and never repeats it (NFR-SE-19).
  const foundingTeamEmails = list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const address = acceptedAddress(entry);
      if (address === null) {
        throw new Error(
          `FOUNDING_TEAM_EMAILS: entry ${index + 1} is not an email address that an account can have. Write it in the form name@example.com, with its domain in plain letters, digits and hyphens.`,
        );
      }
      return address;
    });

  return {
    foundingTeamEmails,
    appOrigin,
    databaseUrl: required(env, 'DATABASE_URL', 'Set it to the connection string of the role ekdotico_app.'),
    valkeyUrl: required(env, 'VALKEY_URL', 'Set it to the address of Valkey.'),
    authSecret,
    trustedProxyCount,
    sessionIdleSeconds,
    sessionRenewSeconds,
    sessionMaxSeconds,
    cookieCacheSeconds: wholeNumber(env, 'COOKIE_CACHE_SECONDS', 60, 0),
    passwordMinLength,
    passwordMaxLength,
    passwordListFile: env.PASSWORD_LIST_FILE || 'data/common-passwords.txt',
    // At least 1 each: a second step of 0 seconds could never be completed,
    // and with 0 wrong codes no count would ever reach the number.
    secondStepSeconds: wholeNumber(env, 'TWO_FACTOR_STEP_SECONDS', 600, 1),
    secondStepWrongCodes: wholeNumber(env, 'TWO_FACTOR_WRONG_CODES', 5, 1),
    signInLockSeconds,
    admissionSecret: admission,
    // At least 1: an invitation of 0 days has expired before its email is read.
    admissionInvitationDays: wholeNumber(env, 'ADMISSION_INVITATION_DAYS', 30, 1),
    documentInvitationDays,
    // At least 1: a reminder of 0 days would come as the invitation expires, a clearing of 0 as it ends.
    invitationReminderDays,
    documentInvitationAddressDays,
    ownershipOfferDays: wholeNumber(env, 'OWNERSHIP_OFFER_DAYS', 14, 1),
    clearingNoticeDays: wholeNumber(env, 'CLEARING_NOTICE_DAYS', 7, 1),
    securityLogRetentionDays: wholeNumber(env, 'SECURITY_LOG_RETENTION_DAYS', 30, 1),
    deletedDocumentRetentionDays,
    // At least 1 each: a limit of 0 would refuse every image, a period of 0 would delete an image
    // at the next run after it left the document, with undo able to bring it back no more.
    imageDocumentBytes: wholeNumber(env, 'IMAGE_DOCUMENT_MEGABYTES', 100, 1) * 1024 * 1024,
    imageUnreferencedDays: wholeNumber(env, 'IMAGE_UNREFERENCED_DAYS', 30, 1),
    imageLinkSeconds: imageLinkSeconds(env),
    imageStorage: imageStorage(env, [authSecret, admission]),
    emailTransport: transport,
    emailSinkDirectory: env.EMAIL_SINK_DIRECTORY || '.local/mail',
    emailFrom,
    emailSender: sender,
    brevoApiKey: brevoKey,
    collabStoreDelayMs,
    collabStoreMaxMs,
    collabErrorAfterMs: wholeNumber(env, 'COLLAB_ERROR_AFTER_MS', 30000, 1),
    collabHost: collabHost(env),
    collabRecheckMs,
    // At least 1: an idle period of 0 would abort every export before its first byte.
    exportIdleSeconds: wholeNumber(env, 'EXPORT_IDLE_SECONDS', 30, 1),
    exportNameMaxChars: exportNameMaxChars(env),
    healthcheckTimersUrl: checkInUrl(env, 'HEALTHCHECK_TIMERS_URL'),
    healthcheckEmailUrl: checkInUrl(env, 'HEALTHCHECK_EMAIL_URL'),
    limits,
  };
}

const SINK_REFUSED =
  'EMAIL_TRANSPORT=sink is for a development machine: it writes each email to a file. Set EMAIL_TRANSPORT to brevo.';

/**
 * Refuses a start with `EMAIL_TRANSPORT=sink` anywhere but a development
 * machine (register D270; §2.7, the files of the email sink). The sink writes
 * each message to a file that holds an address and may hold a single-use link,
 * and a deployment has no row of the retention schedule for those files. A
 * development machine is the one every other rule of this file takes it to be:
 * an origin on localhost.
 *
 * It is a check of the start of each process (src/instrumentation.ts, and the
 * start of src/collab/server.ts) and not of `loadSettings`, which the tests
 * call with an origin that is not local and the sink: they start no process,
 * and write their files to a directory of their own. `loadSettings` itself
 * gives the same message where the sink has no directory away from a
 * development machine, so that this is the first thing such a deployment is told.
 */
export function refuseSinkAwayFromDevelopment({
  appOrigin,
  emailTransport,
}: Pick<Settings, 'appOrigin' | 'emailTransport'>): void {
  if (emailTransport === 'sink' && !['localhost', '127.0.0.1'].includes(new URL(appOrigin).hostname)) {
    throw new Error(SINK_REFUSED);
  }
}

/**
 * Refuses a start where the application is not on localhost and the build it
 * runs holds the development rewrite of `/collab` (next.config.ts): `next
 * start` reads its rewrites from the build and never from the environment, so
 * a build made with `COLLAB_PROXY_TARGET` would serve the rewrite wherever it
 * is started, whatever is set there.
 *
 * `manifest` is the text of `.next/routes-manifest.json`, or null where the
 * file is absent. On localhost that is no fault: the development server has
 * no build. Anywhere else a build that cannot be checked is refused as one
 * that fails the check, whether the file is absent or cannot be read as a
 * manifest: a start from another directory would otherwise pass unchecked.
 */
export function refuseBuiltCollabRewrite(appOrigin: string, manifest: string | null): void {
  if (['localhost', '127.0.0.1'].includes(new URL(appOrigin).hostname)) return;
  if (manifest === null) {
    throw new Error(
      'The routes manifest of the build was not found at .next/routes-manifest.json: start the application in the directory that holds its build.',
    );
  }
  let rewrites: unknown;
  try {
    rewrites = (JSON.parse(manifest) as { rewrites?: unknown }).rewrites;
  } catch {
    rewrites = undefined;
  }
  if (rewrites === null || typeof rewrites !== 'object') {
    throw new Error('The routes manifest of the build cannot be read: build the application again.');
  }
  // An array in an older manifest, and three lists by name in this one.
  const all = (Array.isArray(rewrites) ? rewrites : Object.values(rewrites).flat()) as unknown[];
  const collab = all.some((each) => {
    const source = (each as { source?: unknown } | null)?.source;
    return typeof source !== 'string' || source === '/collab' || source.startsWith('/collab/');
  });
  if (collab) {
    throw new Error(
      'This build passes /collab to the collaboration server itself, which is for a development machine: build the application again without COLLAB_PROXY_TARGET.',
    );
  }
}

let loaded: Settings | undefined;

/** The settings of this process, read once. A process checks them at start by calling `loadSettings`. */
export function settings(): Settings {
  return (loaded ??= loadSettings());
}

/**
 * The settings of the collaboration server, which sends no email: the first call of its start, before any
 * `settings()`, so that every later `settings()` of that process is this load. It holds no key of Brevo.
 */
export function collabSettings(): Settings {
  return (loaded ??= loadSettings(process.env, false));
}
