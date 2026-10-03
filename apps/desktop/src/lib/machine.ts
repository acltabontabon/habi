/**
 * What Habi says about skills kept in the person's own folders. The wording
 * for which copy a client uses lives here and nowhere else, so every screen
 * says the same thing and none of them guesses for a client that has not
 * documented it.
 */
import type { MachineSkill } from "../bindings/MachineSkill";
import type { ProjectCopy } from "../bindings/ProjectCopy";
import { clientsPhrase } from "./format";

/** The project's copy of a personal skill, as a word: the same files, or not. */
export function copyState(copy: ProjectCopy): "identical" | "differs" {
  return copy.identical ? "identical" : "differs";
}

/**
 * What happens on this machine when a project holds a copy of a personal
 * skill: Claude Code uses the personal one, Gemini CLI the project's; for the
 * others the order is not documented. `null` when no client reads both, so
 * neither hides the other.
 */
export function precedenceNote(copy: ProjectCopy): string | null {
  const wins = copy.sharedReaders.filter((u) => u.precedence === "personalWins").map((u) => u.client);
  const project = copy.sharedReaders.filter((u) => u.precedence === "projectWins").map((u) => u.client);
  const unknown = copy.sharedReaders.filter((u) => u.precedence === "notDocumented").map((u) => u.client);
  const parts: string[] = [];
  const uses = (clients: unknown[]) => (clients.length > 1 ? "use" : "uses");
  if (wins.length > 0) parts.push(`On this machine ${clientsPhrase(wins)} ${uses(wins)} the global copy.`);
  if (project.length > 0) parts.push(`${clientsPhrase(project)} ${uses(project)} the project's copy.`);
  if (unknown.length > 0) {
    parts.push(`Which copy ${clientsPhrase(unknown)} ${uses(unknown)} is not documented.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The files of a skill whose text points into a home folder, for the warning before it is shared. */
export function homeMention(skill: MachineSkill): string | null {
  if (skill.mentionsHome.length === 0) return null;
  const files = skill.mentionsHome.slice(0, 3).join(", ");
  const more = skill.mentionsHome.length > 3 ? ` and ${skill.mentionsHome.length - 3} more` : "";
  return `${files}${more}`;
}

/** The folder a project copy sits in, from its project-relative path ("a/b/skill" → "a/b"). */
export function copyFolder(copy: ProjectCopy): string {
  return copy.path.split("/").slice(0, -1).join("/");
}
