// Settings read from the environment when a process starts. The web application
// and the collaboration server both load them through this one module.

export interface Settings {
  /** The founding team's addresses, lower case (FR-AU-83; register D114, A102). */
  foundingTeamEmails: readonly string[];
}

export function loadSettings(env: Record<string, string | undefined> = process.env): Settings {
  const list = env.FOUNDING_TEAM_EMAILS;
  // A102: a process refuses to start where the setting is absent, so that a
  // deployment cannot lose the two-factor requirement by losing the setting.
  // A list with no address is written as an empty value.
  if (list === undefined) {
    throw new Error(
      'FOUNDING_TEAM_EMAILS is not set. Set it to the founding team’s addresses, separated by commas, or to an empty value.',
    );
  }
  return {
    foundingTeamEmails: list
      .split(',')
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
  };
}
