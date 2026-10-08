import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  // The development server would write an AGENTS.md of its own into the repository.
  agentRules: false,
};

export default config;
