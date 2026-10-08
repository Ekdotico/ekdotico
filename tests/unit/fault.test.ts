import { describe, expect, it } from 'vitest';
import { faultOf } from '../../src/lib/fault.ts';

// NFR-SE-19: a log line tells one fault from another and holds nothing a fault carried.
describe('faultOf', () => {
  it('gives the class and the code of an error of the database client', () => {
    class PrismaClientKnownRequestError extends Error {
      name = 'PrismaClientKnownRequestError';
      code = 'P1001';
    }
    const error = new PrismaClientKnownRequestError("Can't reach database server at db.example.test:5432");
    expect(faultOf(error)).toBe('PrismaClientKnownRequestError P1001');
  });

  it('gives the code of a system error, and of a cause where the error has none', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 192.0.2.7:6379'), { code: 'ECONNREFUSED' });
    expect(faultOf(refused)).toBe('Error ECONNREFUSED');
    const denied = Object.assign(new Error('permission denied for table "User"'), { code: '42501' });
    expect(faultOf(new TypeError('The query failed.', { cause: denied }))).toBe('TypeError 42501');
    // The error's own code comes first.
    expect(faultOf(Object.assign(new Error('x', { cause: denied }), { code: 'ENOENT' }))).toBe(
      'Error ENOENT',
    );
  });

  it('gives the class alone where there is no code, and never the message', () => {
    expect(faultOf(new RangeError('person@example.com is not a number'))).toBe('RangeError');
  });

  it.each(['not even an error', undefined, null, 42, { name: 'person@example.com', code: 'P1001' }])(
    'gives nothing of %j, which is no error',
    (thrown) => {
      expect(faultOf(thrown)).toBe('unknown');
    },
  );

  it.each([
    '192.0.2.7',
    'person@example.com',
    'two words',
    'redis://secret@host',
    '',
    'A'.repeat(17),
    42501,
    { toString: () => 'P1001' },
  ])('does not print the code %j', (code) => {
    expect(faultOf(Object.assign(new Error('x'), { code }))).toBe('Error');
    expect(faultOf(new Error('x', { cause: Object.assign(new Error('y'), { code }) }))).toBe('Error');
  });
});
