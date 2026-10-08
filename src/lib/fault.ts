// What a log line may say of a fault (NFR-SE-19): the class of the error and,
// where it carries one, its code, which tells one fault from another: Prisma's
// `P1001`, PostgreSQL's `42501`, Node's `ECONNREFUSED`. Never the message, which
// can quote a row, an address, or a connection string.

/**
 * The class of an error, and its code or that of its cause. A code is printed
 * only where it is a short string of letters and digits: the field is whatever
 * the thrower put there, and anything else could be an address.
 */
export function faultOf(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = [error, error.cause]
    .map((each) => (each as { code?: unknown } | null | undefined)?.code)
    .find((each) => typeof each === 'string' && /^[A-Za-z0-9]{1,16}$/.test(each));
  return code ? `${error.name} ${code}` : error.name;
}
