/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://github.com/ConnorSawaya/overcode",

  // GitHub
  github: {
    repoUrl: "https://github.com/ConnorSawaya/overcode",
    starsFormatted: {
      compact: "195K",
      full: "195,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/overcode",
    discord: "https://discord.gg/overcode",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "950",
    commits: "13,000",
    monthlyUsers: "16M",
  },
} as const
