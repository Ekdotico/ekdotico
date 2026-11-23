import { describe, expect, it } from 'vitest';
import { assertOrigin } from '../../scripts/measure/commands.ts';

describe('where the measuring command sends cookies', () => {
  it('takes the collaboration address of the origin, and one on this machine', () => {
    expect(() => assertOrigin('https://app.example.test')).not.toThrow();
    expect(() => assertOrigin('https://app.example.test', 'wss://app.example.test/collab')).not.toThrow();
    expect(() => assertOrigin('https://app.example.test', 'ws://127.0.0.1:40123/collab')).not.toThrow();
    expect(() => assertOrigin('http://localhost:3000', 'ws://localhost:1234/collab')).not.toThrow();
  });

  it('refuses a collaboration address on another host, and one that only looks local', () => {
    expect(() => assertOrigin('https://app.example.test', 'wss://other.example.test/collab')).toThrow(
      /host of --origin/,
    );
    expect(() => assertOrigin('https://app.example.test', 'wss://app.example.test:8443/collab')).toThrow(
      /host of --origin/,
    );
    expect(() => assertOrigin('https://app.example.test', 'ws://localhost.example.test/collab')).toThrow(
      /host of --origin/,
    );
  });
});
