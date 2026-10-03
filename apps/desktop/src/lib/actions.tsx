/**
 * App-wide actions that open from several places (welcome, sidebar, palette,
 * project views): opening a project, creating a skill, adding skills.
 */
import { createContext, useContext } from "react";
import type { SkillTemplate } from "../bindings/SkillTemplate";
import type { AddSkillsStart } from "../views/skills/AddSkillsDialog";

/** Where a new skill starts: for a project, or from an idea with a title and layout filled in. */
export type NewSkillContext = {
  projectId?: string;
  projectName?: string;
  title?: string;
  template?: SkillTemplate;
};

export type Actions = {
  /** Picks a folder and registers it; goes to the project unless `stay`. */
  openProject: (options?: { stay?: boolean }) => Promise<void>;
  newSkill: (context?: NewSkillContext) => void;
  addSkills: (start?: AddSkillsStart) => void;
  /** Opens the welcome overlay: what Habi is for, and what this machine has for it. */
  showWelcome: () => void;
};

export const ActionsContext = createContext<Actions | null>(null);

export function useActions(): Actions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("useActions outside the app shell");
  return actions;
}
