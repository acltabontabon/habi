/**
 * One skill's trip through Habi: from another team's library, into a
 * repository, improved, and back to everyone.
 *
 * The app views in Duo.astro are drawn from the fixtures (the example team
 * library as a Git repository, billing-service and platform-monorepo) and the
 * snapshot in recommendations.json.
 */
export type Step = {
  id: "explore" | "check" | "use" | "pay" | "everyone";
  verb: string;
  title: string;
  says: string;
  cwd: string;
};

export const journey: Step[] = [
  {
    id: "explore",
    verb: "Explore",
    title: "Another team's library, connected",
    says: "A Git repository you already have access to. Nothing to migrate, nothing to host.",
    cwd: "",
  },
  {
    id: "check",
    verb: "Check",
    title: "What fits this repository, and why",
    says: "Read from pom.xml — nothing built, nothing run.",
    cwd: "billing-service",
  },
  {
    id: "use",
    verb: "Use",
    title: "In the agent you already use",
    says: "Every file previewed first. Every change restorable.",
    cwd: "billing-service",
  },
  {
    id: "pay",
    verb: "Pay it forward",
    title: "Your fix, back where it came from",
    says: "Only what you include leaves your machine. The owning team reviews and merges.",
    cwd: "billing-service",
  },
  {
    id: "everyone",
    verb: "Everyone gets it",
    title: "The next project starts from it",
    says: "Reviewed and merged by the team. Picked up on refresh.",
    cwd: "platform-monorepo",
  },
];
