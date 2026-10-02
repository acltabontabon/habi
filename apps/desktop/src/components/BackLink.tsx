/**
 * "Back" at the top of a detail screen. Returns to where the person came
 * from (for example the project after "Edit in My skills"), and falls back to
 * the screen's own list when there is no history.
 */
import { type Route, useNav } from "../lib/nav";
import { useRecentProjects } from "../lib/queries";
import { Icon } from "./Icon";

function useRouteLabel(route: Route | undefined): string | null {
  const recent = useRecentProjects();
  if (!route) return null;
  switch (route.name) {
    case "project":
      return recent.data?.find((p) => p.id === route.projectId)?.name ?? "the project";
    case "skills":
      return route.skillId ? "the skill" : "My skills";
    case "contributions":
      return route.contributionId ? "the contribution" : "Contributions";
    case "sources":
      return route.sourceId ? "the library" : "Team libraries";
    case "settings":
      return "Settings";
    case "welcome":
      return "Home";
  }
}

export function BackLink({ fallback, fallbackLabel }: { fallback: Route; fallbackLabel: string }) {
  const { previous, back, navigate } = useNav();
  const label = useRouteLabel(previous);
  return (
    <button type="button" className="editor-back" onClick={() => (previous ? back() : navigate(fallback))}>
      <Icon name="arrowLeft" size={14} /> {previous && label ? label : fallbackLabel}
    </button>
  );
}
