/** The command-line tools Habi leans on, and how to get each one on this machine. */
import type { AppInfo } from "../bindings/AppInfo";

export type ToolKey = "git" | "gh" | "glab";

export type ToolFact = {
  key: ToolKey;
  name: string;
  /** What having it lets Habi do. */
  purpose: string;
  /** Without it a main part of Habi stops working; the others only add review. */
  required: boolean;
  /** Where its own site explains every way to install it. */
  url: string;
  /** What to run once it is installed, to let it act as you. */
  after?: string;
};

export const TOOLS: ToolFact[] = [
  {
    key: "git",
    name: "Git",
    purpose: "Pulls libraries from GitHub, GitLab or any Git host.",
    required: true,
    url: "https://git-scm.com/downloads",
  },
  {
    key: "gh",
    name: "GitHub CLI",
    purpose: "Reads and opens pull requests on GitHub.",
    required: false,
    url: "https://cli.github.com",
    after: "gh auth login",
  },
  {
    key: "glab",
    name: "GitLab CLI",
    purpose: "Reads and opens merge requests on GitLab.",
    required: false,
    url: "https://gitlab.com/gitlab-org/cli#installation",
    after: "glab auth login",
  },
];

const COMMANDS: Record<ToolKey, Record<string, string | undefined>> = {
  git: { macos: "xcode-select --install", windows: "winget install --id Git.Git -e" },
  gh: { macos: "brew install gh", windows: "winget install --id GitHub.cli -e" },
  glab: { macos: "brew install glab", windows: "winget install --id GitLab.GLab -e" },
};

/** One line to paste into a terminal on this platform, when there is a dependable one. */
export function installCommand(tool: ToolKey, platform: string): string | undefined {
  return COMMANDS[tool][platform];
}

export function isFound(
  info: Pick<AppInfo, "gitAvailable" | "ghAvailable" | "glabAvailable">,
  tool: ToolKey,
) {
  return tool === "git" ? info.gitAvailable : tool === "gh" ? info.ghAvailable : info.glabAvailable;
}
