/** Agents by the names people call them. */
const NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  junie: "Junie",
};

export const clientName = (client: string) => NAMES[client] ?? client;
