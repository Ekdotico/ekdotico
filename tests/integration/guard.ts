// The guard of an action that asks for the prompt (src/lib/account/guard.ts; FR-ED-47, FR-AU-92, D285), for a test that
// calls the action itself and not its route. The route asks for the password and builds the real one; here the password
// and the session are taken to stand, and no recovery code is spent. `guard` of the action is required, so that no
// caller omits it by accident.
import type { Guard } from '../../src/lib/account/guard.ts';

export const HELD: Guard = { standing: async () => 'held', spend: null };

/** A guard whose check finds what the test says: the password changed, or the session ended, since it was asked. */
export const standingAs = (found: 'ended' | 'outrun', spend: Guard['spend'] = null): Guard => ({
  standing: async () => found,
  spend,
});
