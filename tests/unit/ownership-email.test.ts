// FR-ED-47: the email of an offer of ownership has the subject and the fixed
// text of the requirement, verbatim, states who made the offer, and "carries
// neither the title nor any content of the document" (the owner's decision of
// 19 October 2026: no title reaches the email provider). The function is handed
// no title, so none can be written; the integration test reads the file the
// sink wrote for a document whose title is distinctive.
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.example.test';

async function email(ownerName: string, expiresAt: Date) {
  vi.resetModules();
  vi.doMock('../../src/lib/settings.ts', () => ({ settings: () => ({ appOrigin: ORIGIN }) }));
  const { offerEmail } = await import('../../src/lib/documents/ownership.ts');
  return offerEmail('editor@example.com', ownerName, expiresAt);
}
afterEach(() => vi.doUnmock('../../src/lib/settings.ts'));

describe('the email of an offer of ownership', () => {
  it('has the subject and the fixed text of FR-ED-47, with the notification list as its link', async () => {
    const { to, subject, text } = await email('Ada Owner', new Date(Date.UTC(2026, 9, 2, 14, 5, 59)));
    expect(to).toBe('editor@example.com');
    expect(subject).toBe('An offer of ownership of a document in Ekdotico');
    expect(text).toBe(
      `Ada Owner has offered you ownership of a document that you edit in Ekdotico. To accept or decline, open your notifications in Ekdotico: ${ORIGIN}/notifications. The offer is open until 2 Oct 2026, 14:05 UTC. If you accept, you become the Owner of the document and Ada Owner becomes an Editor.`,
    );
  });

  it('holds no link to a document and no token, and no line break in the subject', async () => {
    const { subject, text } = await email('Ada Owner', new Date(Date.UTC(2026, 9, 2)));
    expect(text).not.toMatch(/\/documents\//);
    expect(text).not.toMatch(/\/ownership-offers\//);
    expect(subject).not.toMatch(/[\r\n]/);
  });
});
