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
      if (route.skillId) return "the skill";
      return route.tab === "machine" ? "On this machine" : "My skills";
    case "contributions":
      return route.contributionId ? "the contribution" : "Contributions";
    case "sources":
      if (route.sourceId || route.entry) return "the library";
      if (route.view === "explore") return "Explore";
      return route.view ? "Add a library" : "Your libraries";
    case "settings":
      return "Settings";
    case "about":
      return "About";
    case "privacy":
      return "Privacy & security";
    case "welcome":
      return "Home";
  }
}

export function BackLink({
  fallback,
  fallbackLabel,
  compact,
}: {
  fallback: Route;
  fallbackLabel: string;
  /** Just the arrow, named for assistive technology and on hover. */
  compact?: boolean;
}) {
  const { previous, back, navigate } = useNav();
  const label = useRouteLabel(previous);
  const text = previous && label ? label : fallbackLabel;
  return (
    <button
      type="button"
      className={`editor-back${compact ? " is-icon" : ""}`}
      title={compact ? text : undefined}
      aria-label={compact ? `Back to ${text}` : undefined}
      onClick={() => (previous ? back() : navigate(fallback))}
    >
      <Icon name="arrowLeft" size={14} /> {compact ? null : text}
    </button>
  );
}
