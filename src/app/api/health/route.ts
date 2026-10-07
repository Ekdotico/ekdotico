// NFR-SE-05 (c): reports whether the service is up and returns nothing else.
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
