// NFR-SE-07: a limit "for each address" must not be escaped by a client that
// holds many addresses. One IPv6 subscriber holds a /64.
import { describe, expect, it } from 'vitest';
import { bucketOf } from '../../src/lib/client-address.ts';

describe('bucketOf', () => {
  it('counts an IPv4 address by itself', () => {
    expect(bucketOf('203.0.113.9')).toBe('203.0.113.9');
    expect(bucketOf('203.0.113.9')).not.toBe(bucketOf('203.0.113.10'));
  });

  it.each([
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:0000:0000:0000:0001', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8::', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['2001:db8:1::2:3:4:5', '2001:db8:1:0::/64'],
  ])('counts %s under %s', (address, bucket) => {
    expect(bucketOf(address)).toBe(bucket);
  });

  it('keeps two subscribers apart', () => {
    expect(bucketOf('2001:db8:1:2::1')).not.toBe(bucketOf('2001:db8:1:3::1'));
  });

  it('leaves the bucket of an unknown address as it is', () => {
    expect(bucketOf('unknown')).toBe('unknown');
  });
});
