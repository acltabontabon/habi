/**
 * Well-known community skill libraries, offered as a starting point when
 * connecting one. A short, fixed list in the app — no index service, no
 * popularity ranking. Each was checked to index cleanly in Habi; none has
 * been reviewed for your team, which is why they connect as *community*.
 *
 * Aggregators that re-host other people's skills are left out on purpose:
 * their copies drift from the originals.
 */
export type CommunityLibrary = {
  name: string;
  url: string;
  /** What is in it, in one line. */
  summary: string;
  /** What to know before relying on it. */
  note: string;
};

export const COMMUNITY_LIBRARIES: CommunityLibrary[] = [
  {
    name: "Anthropic",
    url: "https://github.com/anthropics/skills",
    summary: "Anthropic's public Agent Skills: documents, design, MCP servers and skill authoring.",
    note: "Licences differ per skill; the document skills are proprietary.",
  },
  {
    name: "Superpowers",
    url: "https://github.com/obra/superpowers",
    summary: "An engineering process: brainstorming, plans, test-driven development, debugging, review.",
    note: "MIT. Skills call each other by name — install the ones they reference together.",
  },
  {
    name: "Addy Osmani",
    url: "https://github.com/addyosmani/agent-skills",
    summary: "Production engineering practices for coding agents, from API design to CI/CD.",
    note: "MIT.",
  },
  {
    name: "wshobson",
    url: "https://github.com/wshobson/agents",
    summary: "A large plugin collection: 180+ skills across languages, frameworks and platforms.",
    note: "MIT. Broad and uneven; read before adopting.",
  },
  {
    name: "Vercel",
    url: "https://github.com/vercel-labs/agent-skills",
    summary: "React, Next.js, React Native and composition practices from Vercel.",
    note: "Licences differ per skill.",
  },
];
