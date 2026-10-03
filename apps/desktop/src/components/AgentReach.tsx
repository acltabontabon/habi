/**
 * Which agent tools a skill reaches: every tool Habi knows, the ones it
 * reaches lit. One glance answers "did that reach Codex?" without reading
 * folder names; hovering a tool says where it reads from.
 */
import type { ClientId } from "../bindings/ClientId";
import { ALL_CLIENTS, clientLabel, clientsPhrase } from "../lib/format";

export function AgentReach({
  lit,
  label = "Read by",
  tip,
  onlyLit = false,
}: {
  lit: ClientId[];
  /** Read with the lit tools for the accessible name ("Installed for Claude Code and Codex"). */
  label?: string;
  /** The tooltip for one tool, lit or not. */
  tip?: (client: ClientId, on: boolean) => string;
  /** Show only the tools it reaches, where the others would be noise. */
  onlyLit?: boolean;
}) {
  return (
    <span className="reach" role="img" aria-label={`${label} ${clientsPhrase(lit)}`}>
      {ALL_CLIENTS.filter((c) => !onlyLit || lit.includes(c)).map((c) => {
        const on = lit.includes(c);
        return (
          <span key={c} className={`reach-agent${on ? " is-on" : ""}`} data-tip={tip?.(c, on)}>
            {clientLabel[c]}
          </span>
        );
      })}
    </span>
  );
}
