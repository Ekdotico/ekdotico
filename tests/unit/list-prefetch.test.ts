// P-01: the pages of the app are all dynamic, so a prefetched link renders its whole page on the server.
// The list of documents held one link for each row, and the header three more, each prefetched on sight
// (about 100 queries for one view of the list). Every link in these two files names `prefetch={false}`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe.each(['src/app/(app)/documents.tsx', 'src/app/(app)/shell-header.tsx'])('links of %s', (file) => {
  const links = [...readFileSync(file, 'utf8').matchAll(/<Link\b[^>]*>/g)].map(([tag]) => tag);

  it('has links to look at', () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it('prefetches none of them', () => {
    for (const tag of links) expect(tag).toContain('prefetch={false}');
  });
});
