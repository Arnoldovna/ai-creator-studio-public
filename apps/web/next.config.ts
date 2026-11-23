import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@studio/core'],
  poweredByHeader: false,
  // Agent instructions live in the repo's CLAUDE.md; don't generate an AGENTS.md.
  agentRules: false,
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
    },
  },
};

export default nextConfig;
