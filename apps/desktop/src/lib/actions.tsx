/**
 * App-wide actions that open from several places (welcome, sidebar, palette,
 * project views): opening a project, creating a skill, adding skills.
 */
import { createContext, useContext } from "react";
import type { AddSkillsStart } from "../views/skills/AddSkillsDialog";

export type Actions = {
  /** Picks a folder and registers it; goes to the project unless `stay`. */
  openProject: (options?: { stay?: boolean }) => Promise<void>;
  newSkill: (context?: { projectId: string; projectName: string }) => void;
  addSkills: (start?: AddSkillsStart) => void;
};

export const ActionsContext = createContext<Actions | null>(null);

export function useActions(): Actions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("useActions outside the app shell");
  return actions;
}
