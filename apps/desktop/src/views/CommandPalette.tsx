/** ⌘K: jump to projects, libraries, items in the open project, and actions. */
import * as RadixDialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import type { ProjectOverview } from "../bindings/ProjectOverview";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { useActions } from "../lib/actions";
import { api, newJobId } from "../lib/api";
import { applicabilityLabel } from "../lib/format";
import { useNav } from "../lib/nav";
import { invalidateProjectData, keys, useRecentProjects, useSkills, useSources } from "../lib/queries";
import { useTheme } from "../lib/theme";

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { route, navigate } = useNav();
  const projects = useRecentProjects();
  const sources = useSources();
  const skills = useSkills();
  const { openProject, newSkill, addSkills } = useActions();
  const client = useQueryClient();
  const toast = useToast();
  const [theme, setTheme] = useTheme();
  const projectId = route.name === "project" ? route.projectId : undefined;
  const overview = projectId ? client.getQueryData<ProjectOverview>(keys.overview(projectId)) : undefined;

  const refreshAll = async () => {
    const list = sources.data ?? [];
    if (list.length === 0) {
      toast.show("No libraries are connected yet.");
      return;
    }
    toast.show(`Refreshing ${list.length === 1 ? list[0]?.name : `${list.length} libraries`}…`);
    const results = await Promise.allSettled(list.map((s) => api.refreshSource(s.id, newJobId())));
    invalidateProjectData(client);
    const failed = list.filter((_, i) => results[i]?.status === "rejected").map((s) => s.name);
    if (failed.length === 0) {
      toast.show(
        `${list.length === 1 ? list[0]?.name : `All ${list.length} libraries`} refreshed. Installed copies were not changed.`,
      );
    } else {
      toast.show(
        `Could not refresh ${failed.join(", ")}. Open Team libraries for details; the offline copy stays available.`,
        "danger",
      );
    }
  };

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-scrim" />
        <RadixDialog.Content className="palette" aria-describedby={undefined}>
          <RadixDialog.Title className="visually-hidden">Search and commands</RadixDialog.Title>
          <Command label="Search and commands" loop>
            <div className="palette-input">
              <Icon name="search" />
              <Command.Input placeholder="Search projects, skills, libraries, actions…" autoFocus />
            </div>
            <Command.List className="palette-list">
              <Command.Empty className="palette-empty">No matches.</Command.Empty>
              {overview ? (
                <Command.Group heading={`In ${overview.project.name}`}>
                  {overview.recommendations.map((r) => (
                    <Command.Item
                      key={r.item.key}
                      value={`${r.item.title} ${r.item.id}`}
                      onSelect={() =>
                        run(() =>
                          navigate({
                            name: "project",
                            projectId: overview.project.id,
                            tab: "recommendations",
                            itemKey: r.item.key,
                          }),
                        )
                      }
                    >
                      <Icon name="thread" />
                      <span>Why {r.item.title}?</span>
                      <span className="palette-meta">
                        {r.applicability.applicability === "applies"
                          ? "fits"
                          : applicabilityLabel[r.applicability.applicability].toLowerCase()}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              <Command.Group heading="Projects">
                {(projects.data ?? []).map((p) => (
                  <Command.Item
                    key={p.id}
                    value={`project ${p.name} ${p.path}`}
                    disabled={!p.exists}
                    onSelect={() =>
                      run(() => navigate({ name: "project", projectId: p.id, tab: "recommendations" }))
                    }
                  >
                    <Icon name="folder" />
                    <span>{p.name}</span>
                    <span className="palette-meta mono">{p.path}</span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="My skills">
                {(skills.data ?? [])
                  .filter((sk) => sk.deletedAt === null)
                  .map((sk) => (
                    <Command.Item
                      key={sk.id}
                      value={`skill ${sk.title} ${sk.name}`}
                      onSelect={() => run(() => navigate({ name: "skills", skillId: sk.id }))}
                    >
                      <Icon name="pencil" />
                      <span>{sk.title || "Untitled skill"}</span>
                      <span className="palette-meta mono">{sk.name}</span>
                    </Command.Item>
                  ))}
              </Command.Group>
              <Command.Group heading="Libraries">
                {(sources.data ?? []).map((s) => (
                  <Command.Item
                    key={s.id}
                    value={`library ${s.name}`}
                    onSelect={() => run(() => navigate({ name: "sources", sourceId: s.id }))}
                  >
                    <Icon name="library" />
                    <span>{s.name}</span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Actions">
                <Command.Item value="open project folder" onSelect={() => run(() => void openProject())}>
                  <Icon name="folder" /> <span>Open a project…</span> <span className="palette-meta">⌘O</span>
                </Command.Item>
                <Command.Item value="create new skill draft write" onSelect={() => run(() => newSkill())}>
                  <Icon name="pencil" /> <span>Create a skill</span> <span className="palette-meta">⌘N</span>
                </Command.Item>
                <Command.Item
                  value="add import existing skills folder"
                  onSelect={() => run(() => addSkills())}
                >
                  <Icon name="plus" /> <span>Add existing skills…</span>
                </Command.Item>
                <Command.Item
                  value="my skills drafts"
                  onSelect={() => run(() => navigate({ name: "skills" }))}
                >
                  <Icon name="pencil" /> <span>My skills</span>
                </Command.Item>
                <Command.Item
                  value="connect library source git team"
                  onSelect={() => run(() => navigate({ name: "sources", sourceId: "new" }))}
                >
                  <Icon name="library" /> <span>Connect a team library…</span>
                </Command.Item>
                <Command.Item value="refresh all libraries" onSelect={() => run(() => void refreshAll())}>
                  <Icon name="refresh" /> <span>Refresh all libraries</span>
                </Command.Item>
                {projectId ? (
                  <Command.Item
                    value="project facts evidence declarations"
                    onSelect={() => run(() => navigate({ name: "project", projectId, tab: "evidence" }))}
                  >
                    <Icon name="file" /> <span>Show project facts</span>
                  </Command.Item>
                ) : null}
                {projectId ? (
                  <Command.Item
                    value="history installed restore"
                    onSelect={() => run(() => navigate({ name: "project", projectId, tab: "installed" }))}
                  >
                    <Icon name="history" /> <span>Installed items and history</span>
                  </Command.Item>
                ) : null}
                <Command.Item
                  value="share contribute"
                  onSelect={() => run(() => navigate({ name: "contributions" }))}
                >
                  <Icon name="share" /> <span>Contributions</span>
                </Command.Item>
                <Command.Item
                  value="theme dark light"
                  onSelect={() => run(() => setTheme(theme === "dark" ? "light" : "dark"))}
                >
                  <Icon name={theme === "dark" ? "sun" : "moon"} />{" "}
                  <span>Switch to {theme === "dark" ? "light" : "dark"} theme</span>
                </Command.Item>
                <Command.Item
                  value="settings preferences diagnostics"
                  onSelect={() => run(() => navigate({ name: "settings" }))}
                >
                  <Icon name="settings" /> <span>Settings</span> <span className="palette-meta">⌘,</span>
                </Command.Item>
                <Command.Item
                  value="home welcome start"
                  onSelect={() => run(() => navigate({ name: "welcome" }))}
                >
                  <Icon name="arrowLeft" /> <span>Start screen</span>
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
