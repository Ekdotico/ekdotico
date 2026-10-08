// Settings read from the environment when a process starts. The web application
// and the collaboration server both load them through this one module
// (NFR-SE-17 (f)). Every secret is read here and nowhere else (NFR-SE-19).

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
} as const satisfies Record<string, readonly [number, number]>;

export type LimitName = keyof typeof LIMITS;

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
  /** How many proxies stand between a client and this process (the owner's answer to Q5). */
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
   * FR-AU-89: the key of the signed admission requests, or none. Without it
   * every admission request is refused. The name and the form are provisional
   * (docs/contracts/admission-signature.md).
   */
  admissionSecret: string | undefined;
  /** FR-AU-89 (a): how long an admission invitation stays open. */
  admissionInvitationDays: number;
  /** NFR-SE-19: how long a security log entry is kept. */
  securityLogRetentionDays: number;
  /** Where the local sink writes each message (register A52, A72: no real email yet). */
  emailSinkDirectory: string;
  /** The address messages are sent from. */
  emailFrom: string;
  /**
   * NFR-RE-07 (register P14): the collaboration server stores a document's
   * state no later than the first after the last change it received, and at
   * least as often as the second while changes continue. Milliseconds; the
   * initial values are 2 and 10 seconds.
   */
  collabStoreDelayMs: number;
  collabStoreMaxMs: number;
  limits: Readonly<Record<LimitName, Limit>>;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string, hint: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

function wholeNumber(env: Env, name: string, initial: number): number {
  const value = env[name];
  if (value === undefined || value === '') return initial;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be a whole number.`);
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

const DAY = 24 * 60 * 60;

export function loadSettings(env: Env = process.env): Settings {
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
  // The only sender yet is the local sink, which writes each message to a file
  // and sends nothing (register A52, A72). Anywhere but a development machine it
  // has to be chosen in so many words, so that no deployment loses its email
  // unnoticed: sign-in and reset answer the same whether or not a message went.
  const local = ['localhost', '127.0.0.1'].includes(hostname);
  if (env.EMAIL_TRANSPORT ? env.EMAIL_TRANSPORT !== 'sink' : !local) {
    throw new Error('EMAIL_TRANSPORT must be set to sink: no other sender of email is built yet.');
  }
  const authSecret = required(env, 'AUTH_SECRET', 'Set it to a random value of at least 32 characters.');
  if (authSecret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters.');
  // NFR-RE-07: the collaboration server takes the time of the write itself off
  // the first period, and the first period twice off the second
  // (src/collab/server.ts, `storeTimers`), so each has a least value.
  const collabStoreDelayMs = wholeNumber(env, 'COLLAB_STORE_DELAY_MS', 2000);
  const collabStoreMaxMs = wholeNumber(env, 'COLLAB_STORE_MAX_MS', 10000);
  if (collabStoreDelayMs < 1000) throw new Error('COLLAB_STORE_DELAY_MS must be at least 1000.');
  if (collabStoreMaxMs < 2 * collabStoreDelayMs + 1000) {
    throw new Error('COLLAB_STORE_MAX_MS must be at least twice COLLAB_STORE_DELAY_MS and 1000 more.');
  }

  return {
    foundingTeamEmails: list
      .split(',')
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
    appOrigin,
    databaseUrl: required(env, 'DATABASE_URL', 'Set it to the connection string of the role ekdotico_app.'),
    valkeyUrl: required(env, 'VALKEY_URL', 'Set it to the address of Valkey.'),
    authSecret,
    trustedProxyCount: wholeNumber(env, 'TRUSTED_PROXY_COUNT', 0),
    sessionIdleSeconds: wholeNumber(env, 'SESSION_IDLE_SECONDS', 7 * DAY),
    sessionRenewSeconds: wholeNumber(env, 'SESSION_RENEW_SECONDS', DAY),
    sessionMaxSeconds: wholeNumber(env, 'SESSION_MAX_SECONDS', 30 * DAY),
    cookieCacheSeconds: wholeNumber(env, 'COOKIE_CACHE_SECONDS', 60),
    passwordMinLength: wholeNumber(env, 'PASSWORD_MIN_LENGTH', 8),
    passwordMaxLength: wholeNumber(env, 'PASSWORD_MAX_LENGTH', 32),
    passwordListFile: env.PASSWORD_LIST_FILE || 'data/common-passwords.txt',
    admissionSecret: admissionSecret(env),
    admissionInvitationDays: wholeNumber(env, 'ADMISSION_INVITATION_DAYS', 30),
    securityLogRetentionDays: wholeNumber(env, 'SECURITY_LOG_RETENTION_DAYS', 30),
    emailSinkDirectory: env.EMAIL_SINK_DIRECTORY || '.local/mail',
    emailFrom: env.EMAIL_FROM || 'Ekdotico <no-reply@localhost>',
    collabStoreDelayMs,
    collabStoreMaxMs,
    limits: Object.fromEntries(
      (Object.keys(LIMITS) as LimitName[]).map((name) => [name, limit(env, name)]),
    ) as Record<LimitName, Limit>,
  };
}

let loaded: Settings | undefined;

/** The settings of this process, read once. A process checks them at start by calling `loadSettings`. */
export function settings(): Settings {
  return (loaded ??= loadSettings());
}
