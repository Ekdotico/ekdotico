// Work left for after a response (FR-AU-86, FR-AU-87), and the reading of a
// request's body as named fields.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterResponse, collecting } from '../../src/lib/after-response.ts';
import { textFields } from '../../src/lib/http.ts';

afterEach(() => vi.restoreAllMocks());

describe('afterResponse', () => {
  it('starts nothing until the caller runs what was left', async () => {
    const ran: string[] = [];
    const { result, tasks } = await collecting(async () => {
      afterResponse('first', async () => void ran.push('first'));
      await Promise.resolve();
      afterResponse('second', async () => void ran.push('second'));
      return 'answer';
    });
    expect(result).toBe('answer');
    expect(ran).toEqual([]);
    for (const task of tasks) await task();
    expect(ran).toEqual(['first', 'second']);
  });

  it('keeps the work of two requests apart', async () => {
    const [one, two] = await Promise.all([
      collecting(async () => afterResponse('one', async () => {})),
      collecting(async () => {}),
    ]);
    expect([one.tasks.length, two.tasks.length]).toEqual([1, 0]);
  });

  it('throws where no request is collecting, so that no email is dropped in silence', () => {
    expect(() => afterResponse('lost', async () => {})).toThrow();
  });

  it('never rejects, and prints the name of what failed and nothing of the fault (NFR-SE-19)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tasks } = await collecting(async () =>
      afterResponse('password notice', async () => {
        throw new Error('could not send to person@example.com');
      }),
    );
    await expect(tasks[0]!()).resolves.toBeUndefined();
    expect(errors.mock.calls).toEqual([['after response: password notice failed']]);
  });
});

describe('textFields', () => {
  it('returns exactly the named fields where each is text', () => {
    expect(textFields({ id: 'x' }, 'id')).toEqual({ id: 'x' });
    expect(textFields({ b: '', a: 'x' }, 'a', 'b')).toEqual({ a: 'x', b: '' });
  });

  it.each([
    [{ id: 'x', more: 1 }],
    [{ id: 'x', more: undefined }],
    [{}],
    [{ id: 7 }],
    [{ id: null }],
    [{ id: ['x'] }],
    [{ other: 'x' }],
    [['x']],
    ['x'],
    [null],
    [undefined],
    // A name that every object answers to is not a field that was sent.
    [JSON.parse('{"__proto__":"x"}')],
  ])('refuses %j', (body) => {
    expect(textFields(body, 'id')).toBeNull();
  });

  it('does not take a field from the prototype of every object', () => {
    expect(textFields({}, 'toString' as string)).toBeNull();
    expect(textFields({ x: 'y' }, 'constructor' as string)).toBeNull();
  });
});
