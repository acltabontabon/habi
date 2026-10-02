/**
 * Well-known community skill libraries, offered to discover and preview
 * before connecting. A short, fixed list in the app: no index service, no
 * ranking, no network until you connect one. Each was checked to index
 * cleanly in Habi; none has been reviewed for your team, which is why they
 * connect as community libraries. Skill counts and topics are as they were
 * when this list was made — connecting shows the current contents.
 *
 * Aggregators that re-host other people's skills are left out on purpose:
 * their copies drift from the originals.
 */
export type CommunityLibrary = {
  /** Stable id for routes. */
  id: string;
  name: string;
  url: string;
  /** owner/name, as people say it. */
  repo: string;
  /** What is in it, in one line. */
  summary: string;
  /** What it covers, for "what am I adding?". */
  topics: string[];
  /** About how many skills it had when listed. */
  skills: number;
  /** What to know before relying on it. */
  note: string;
};

export const COMMUNITY_LIBRARIES: CommunityLibrary[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    url: "https://github.com/anthropics/skills",
    repo: "anthropics/skills",
    summary: "Anthropic's public Agent Skills: documents, design, MCP servers and skill authoring.",
    topics: [
      "Word, PDF, PowerPoint and Excel files",
      "visual design and themes",
      "MCP servers",
      "web artifacts",
      "writing skills",
    ],
    skills: 20,
    note: "Licences differ per skill; the document skills are proprietary.",
  },
  {
    id: "superpowers",
    name: "Superpowers",
    url: "https://github.com/obra/superpowers",
    repo: "obra/superpowers",
    summary: "An engineering process for coding agents, from first idea to merged branch.",
    topics: [
      "brainstorming",
      "writing and executing plans",
      "test-driven development",
      "systematic debugging",
      "code review",
      "git worktrees",
    ],
    skills: 15,
    note: "MIT. Skills call each other by name — adopt the ones they reference together.",
  },
  {
    id: "addyosmani",
    name: "Addy Osmani",
    url: "https://github.com/addyosmani/agent-skills",
    repo: "addyosmani/agent-skills",
    summary: "Production engineering practices for coding agents.",
    topics: [
      "API and interface design",
      "code review",
      "CI/CD",
      "debugging",
      "documentation and ADRs",
      "frontend engineering",
      "migrations",
    ],
    skills: 25,
    note: "MIT.",
  },
  {
    id: "wshobson",
    name: "wshobson",
    url: "https://github.com/wshobson/agents",
    repo: "wshobson/agents",
    summary: "A large plugin collection across languages, frameworks and platforms.",
    topics: [
      "Python",
      "backend services",
      "data engineering",
      "LLM fine-tuning",
      "UI design",
      "framework migrations",
    ],
    skills: 180,
    note: "MIT. Broad and uneven; read a skill before adopting it.",
  },
  {
    id: "vercel",
    name: "Vercel",
    url: "https://github.com/vercel-labs/agent-skills",
    repo: "vercel-labs/agent-skills",
    summary: "React, Next.js and React Native practices from Vercel.",
    topics: ["React best practices", "composition patterns", "React Native", "view transitions"],
    skills: 9,
    note: "Licences differ per skill.",
  },
];

/** The catalog entry a connected source came from, if any (by address). */
export function catalogEntryFor(location: string): CommunityLibrary | undefined {
  const norm = (u: string) =>
    u
      .toLowerCase()
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
  return COMMUNITY_LIBRARIES.find((c) => norm(c.url) === norm(location));
}
