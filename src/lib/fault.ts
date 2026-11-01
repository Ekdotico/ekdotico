// What a log line may say of a fault (NFR-SE-19): the class of the error and,
// where it carries one, its code, which tells one fault from another: Prisma's
// `P1001`, PostgreSQL's `42501`, Node's `ECONNREFUSED`. Never the message, which
// can quote a row, an address, or a connection string.

/**
 * A code that may be printed: a short string of letters and digits (`P1001`,
 * `ECONNREFUSED`), or of capitals, digits and underscores (`UND_ERR_CONNECT_TIMEOUT`,
 * `EAI_AGAIN`). The field is whatever the thrower put there, and anything else
 * could be an address. The second pattern is capitals only and the first is
 * short, since a token of a link is mixed-case and 22 characters or more.
 */
export function printableCode(code: unknown): string | undefined {
  return typeof code === 'string' && (/^[A-Za-z0-9]{1,16}$/.test(code) || /^[A-Z0-9_]{1,32}$/.test(code))
    ? code
    : undefined;
}

/** The class of an error, and its code or that of its cause (`printableCode`). */
export function faultOf(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = [error, error.cause]
    .map((each) => printableCode((each as { code?: unknown } | null | undefined)?.code))
    .find((each) => each !== undefined);
  return code ? `${error.name} ${code}` : error.name;
}
