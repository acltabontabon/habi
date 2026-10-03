/**
 * What Habi says about skills kept in the person's own folders. The wording
 * for which copy a client uses lives here and nowhere else, so every screen
 * says the same thing and none of them guesses for a client that has not
 * documented it.
 */
import type { ClientId } from "../bindings/ClientId";
import type { MachineSkill } from "../bindings/MachineSkill";
import type { ProjectCopy } from "../bindings/ProjectCopy";
import { ALL_CLIENTS, clientsPhrase } from "./format";

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

/**
 * One skill on this machine, however many folders hold it. Installing for
 * several agent tools writes the same skill to `~/.claude/skills` and
 * `~/.agents/skills`; those are one skill to the person, not two.
 */
export type MachineGroup = {
  key: string;
  /** The copy actions act on: one that can be copied whole, if any can. */
  skill: MachineSkill;
  /** Every folder that holds it, in the order the folders were read. */
  copies: MachineSkill[];
  /** Every agent tool that reads at least one of the copies. */
  readers: ClientId[];
  inProjects: ProjectCopy[];
  mentionsHome: string[];
  isLink: boolean;
  importedAs: string | null;
};

/**
 * Folds copies of one skill together: those Habi installed in one go (the
 * same install), or, for skills Habi did not install, those with the same
 * name and the same files. Copies that differ stay apart.
 */
export function groupMachineSkills(skills: MachineSkill[]): MachineGroup[] {
  const groups = new Map<string, MachineSkill[]>();
  for (const s of skills) {
    const key = s.managed ? `managed:${s.managed.key}` : `same:${s.name}:${s.digest}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups].map(([key, copies]) => {
    const projects = new Map<string, ProjectCopy>();
    for (const c of copies.flatMap((s) => s.inProjects)) {
      const id = `${c.projectId}:${c.path}`;
      const seen = projects.get(id);
      projects.set(
        id,
        seen
          ? {
              ...seen,
              identical: seen.identical && c.identical,
              sharedReaders: [
                ...seen.sharedReaders,
                ...c.sharedReaders.filter((u) => !seen.sharedReaders.some((v) => v.client === u.client)),
              ],
            }
          : c,
      );
    }
    const reads = new Set(copies.flatMap((s) => s.readers));
    return {
      key,
      skill: copies.find((s) => s.complete) ?? (copies[0] as MachineSkill),
      copies,
      readers: ALL_CLIENTS.filter((c) => reads.has(c)),
      inProjects: [...projects.values()],
      mentionsHome: [...new Set(copies.flatMap((s) => s.mentionsHome))],
      isLink: copies.some((s) => s.isLink),
      importedAs: copies.find((s) => s.importedAs)?.importedAs ?? null,
    };
  });
}

/** The files of a skill whose text points into a home folder, for the warning before it is shared. */
export function homeMention(skill: Pick<MachineSkill, "mentionsHome">): string | null {
  if (skill.mentionsHome.length === 0) return null;
  const files = skill.mentionsHome.slice(0, 3).join(", ");
  const more = skill.mentionsHome.length > 3 ? ` and ${skill.mentionsHome.length - 3} more` : "";
  return `${files}${more}`;
}

/** The folder a project copy sits in, from its project-relative path ("a/b/skill" → "a/b"). */
export function copyFolder(copy: ProjectCopy): string {
  return copy.path.split("/").slice(0, -1).join("/");
}
