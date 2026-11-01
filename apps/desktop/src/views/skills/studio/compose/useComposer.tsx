/**
 * Everything composing needs, in one place the Studio can hold: what's on the
 * shelf, what the skill is composed of, and which panel or inspector is open.
 * The document remains the truth; this only reads it and asks it to change.
 */
import { useQuery } from "@tanstack/react-query";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShelfSkill } from "../../../../bindings/ShelfSkill";
import { useToast } from "../../../../components/Toasts";
import { api } from "../../../../lib/api";
import { useNav } from "../../../../lib/nav";
import type { DocEditorHandle } from "../doc/lazy";
import { canonOf } from "../doc/markdown/canon";
import { LOOKS_CHANGED, type SkillLook, type ViewContext } from "../doc/nodeViews";
import type { SlashItem } from "../doc/SlashMenu";
import type { SkillDraft } from "../useSkillDraft";
import {
  canReword,
  dropSkill,
  insertSkill,
  type Pick,
  promote,
  removeUse,
  replaceAll,
  replaceUse,
  selectUse,
  setRole,
} from "./edit";
import { Inside } from "./Inside";
import { knotColor, titleOfName } from "./knots";
import { Overview } from "./Overview";
import { overviewOf } from "./overviewData";
import { type InspectorTarget, RefInspector } from "./RefInspector";
import {
  type ComposeEntry,
  composesKey,
  deriveComposes,
  mentionOf,
  occurrencesIn,
  type RoleId,
  rolesForOpening,
  sentenceFor,
} from "./roles";
import { Shelf } from "./Shelf";
import { type ThreadStatus, Threads } from "./Threads";

export type Panel =
  | { kind: "shelf"; query?: string; inline?: boolean; replace?: { pos: number; name: string; all: boolean } }
  | { kind: "overview" }
  | { kind: "inside" };

const ORIGIN_RANK: Record<string, number> = { mine: 0, library: 1, community: 2, machine: 3, project: 4 };

export const pickOf = (s: ShelfSkill): Pick => ({
  name: s.name,
  // Only a library has an address anyone else could use. Local places stay local.
  from:
    s.libraryUrl && s.itemId
      ? { library: s.libraryUrl, id: s.itemId, ...(s.digest ? { digest: s.digest } : {}) }
      : null,
});

export function useComposer({
  draft,
  editor,
  projectId,
  onOpenFile,
  onWhen,
  onReadiness,
  onSource,
  ready,
  problems,
}: {
  draft: SkillDraft;
  editor: RefObject<DocEditorHandle | null>;
  projectId: string | null;
  onOpenFile: (path: string) => void;
  onWhen: () => void;
  onReadiness: () => void;
  onSource: () => void;
  ready: boolean;
  problems: number;
}) {
  const { skill, id } = draft;
  const { navigate } = useNav();
  const toast = useToast();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [inspector, setInspector] = useState<InspectorTarget | null>(null);
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<EditorView | null>(null);
  const hadChip = useRef(new Set<string>());
  const loaded = useRef<ComposeEntry[]>(draft.composes);
  loaded.current = draft.composes;

  const shelfQuery = useQuery({
    queryKey: ["skill-shelf"],
    queryFn: () => api.skillShelf(),
    staleTime: 30_000,
  });
  const composition = useQuery({
    queryKey: ["skill-composition", id, skill.documentDigest, skill.metadataDigest, projectId],
    queryFn: () => api.skillComposition(id, projectId),
    placeholderData: (previous) => previous,
  });

  const shelf = shelfQuery.data;
  const byName = useMemo(() => {
    const map = new Map<string, ShelfSkill[]>();
    for (const s of shelf ?? []) {
      const list = map.get(s.name);
      if (list) list.push(s);
      else map.set(s.name, [s]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (ORIGIN_RANK[a.origin] ?? 9) - (ORIGIN_RANK[b.origin] ?? 9));
    }
    return map;
  }, [shelf]);
  const deps = useMemo(
    () => new Map((composition.data?.dependencies ?? []).map((d) => [d.name, d])),
    [composition.data],
  );

  const titleOf = useCallback((name: string) => byName.get(name)?.[0]?.title ?? titleOfName(name), [byName]);

  const statusOf = useCallback(
    (name: string): ThreadStatus => {
      const dep = deps.get(name);
      if (dep) {
        if (dep.status === "missing") return "missing";
        if (dep.status === "exact") return "found";
        return dep.status === "named" ? "found" : "unsure";
      }
      if (!shelf) return "unsure";
      return byName.has(name) ? "found" : "missing";
    },
    [deps, shelf, byName],
  );

  const look = useCallback(
    (name: string) => ({ title: titleOf(name), status: statusOf(name) }),
    [titleOf, statusOf],
  );

  // Chips show what's known: when that arrives or changes, they repaint.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are what the chips show.
  useEffect(() => {
    view?.dom.dispatchEvent(new Event(LOOKS_CHANGED));
  }, [view, byName, deps]);

  /** The page opened, or its record changed. */
  const annotate = useCallback((doc: PMNode) => {
    const roles = rolesForOpening(doc, loaded.current);
    hadChip.current = new Set(
      [...roles.values()].length
        ? occurrencesIn(doc)
            .filter((o) => roles.has(o.pos))
            .map((o) => o.name)
        : [],
    );
    return roles;
  }, []);

  const derived = useCallback((doc: PMNode) => {
    for (const o of occurrencesIn(doc)) if (o.role !== null) hadChip.current.add(o.name);
    return deriveComposes(doc, loaded.current, hadChip.current);
  }, []);

  const onSettled = useCallback(
    (doc: PMNode) => {
      const next = derived(doc);
      if (composesKey(next) !== composesKey(loaded.current)) {
        loaded.current = next;
        draft.setComposes(next);
      }
      setTick((t) => t + 1);
    },
    [derived, draft.setComposes],
  );

  // Hand-edited YAML changes the record: the chips follow it.
  const lastRecord = useRef(composesKey(draft.composes));
  useEffect(() => {
    const key = composesKey(draft.composes);
    if (key === lastRecord.current) return;
    lastRecord.current = key;
    const current = view;
    if (!current) return;
    const live = composesKey(deriveComposes(current.state.doc, draft.composes, hadChip.current));
    if (live === key) return;
    const roles = rolesForOpening(current.state.doc, draft.composes);
    if (roles.size) editor.current?.setRoles(roles);
  }, [draft.composes, view, editor]);

  const withView = useCallback(() => {
    const current = editor.current?.view() ?? null;
    if (current !== view) setView(current);
    return current;
  }, [editor, view]);

  useEffect(() => {
    // The page arrives with its lazy code; the view appears once it has.
    const timer = window.setInterval(() => {
      const current = editor.current?.view();
      if (current) {
        setView(current);
        setTick((t) => t + 1);
        window.clearInterval(timer);
      }
    }, 60);
    return () => window.clearInterval(timer);
  }, [editor]);

  const openInspector = useCallback(
    (name: string, pos: number, rect: DOMRect | { left: number; top: number; bottom: number }) => {
      const current = withView();
      if (!current) return;
      const chip = current.state.doc.nodeAt(pos);
      const others = occurrencesIn(current.state.doc)
        .filter((o) => o.name === name && o.pos !== pos)
        .map((o) => o.pos);
      setInspector({
        name,
        pos,
        rect: { left: rect.left, top: rect.top, bottom: rect.bottom },
        role: (chip?.attrs.role as string | null) ?? null,
        otherUses: others,
        canReword: canReword(current, pos),
      });
    },
    [withView],
  );

  const openUse = useCallback(
    (pos: number) => {
      const current = withView();
      if (!current) return;
      const dom = current.nodeDOM(pos);
      const chip = current.state.doc.nodeAt(pos);
      if (!(dom instanceof HTMLElement) || !chip) return;
      dom.scrollIntoView({ block: "center", behavior: "smooth" });
      window.setTimeout(
        () => openInspector(chip.attrs.name as string, pos, dom.getBoundingClientRect()),
        240,
      );
    },
    [withView, openInspector],
  );

  const closeInspector = useCallback(() => {
    setInspector(null);
  }, []);

  const pick = useCallback(
    (s: ShelfSkill) => {
      const current = withView();
      if (!current) return;
      if (panel?.kind === "shelf" && panel.replace) {
        if (panel.replace.all) replaceAll(current, panel.replace.name, pickOf(s));
        else replaceUse(current, panel.replace.pos, pickOf(s));
        setPanel(null);
        current.focus();
        return;
      }
      const inline = panel?.kind === "shelf" && panel.inline;
      insertSkill(current, pickOf(s), { inline });
      current.focus();
      if (inline) setPanel(null);
    },
    [withView, panel],
  );

  const context: ViewContext = useMemo(
    () => ({
      skillLook: (name: string, role: string | null): SkillLook => ({
        title: titleOf(name),
        explicit: role !== null,
        status: statusOf(name),
        dye: knotColor(name),
      }),
      onSkillClick: (name, pos, rect) => openInspector(name, pos, rect),
      onLinkSkill: (query) => setPanel({ kind: "shelf", query, inline: true }),
      onDropSkill: (data, coords) => {
        const current = withView();
        if (!current) return;
        try {
          dropSkill(current, pickOf(JSON.parse(data) as ShelfSkill), coords);
          current.focus();
        } catch {
          // Something else's drag data: nothing to add.
        }
      },
    }),
    [titleOf, statusOf, openInspector, withView],
  );

  const slashExtras = useCallback(
    (query: string): SlashItem[] => {
      const scoped = query.startsWith("skill");
      const words = scoped ? query.slice(5).trim() : query;
      const all = (shelf ?? []).filter((s) => s.name !== draft.document.name);
      const seen = new Set<string>();
      const found = all.filter((s) => {
        if (seen.has(s.name)) return false;
        const hay = `${s.title} ${s.name} ${s.description}`.toLowerCase();
        const hit = words
          .split(/\s+/)
          .filter(Boolean)
          .every((w) => hay.includes(w));
        if (hit) seen.add(s.name);
        return hit;
      });
      const limit = scoped ? 8 : query ? 4 : 0;
      const items: SlashItem[] = found.slice(0, limit).map((s) => ({
        id: `skill:${s.key}`,
        group: "Other skills",
        label: s.title,
        hint: s.sourceLabel,
        act: (v) => {
          insertSkill(v, pickOf(s), { inline: true });
        },
      }));
      const browse: SlashItem = {
        id: "skill-browse",
        group: "Other skills",
        label: "Browse skills…",
        hint: "⌘⇧K",
        keywords: "skill compose shelf",
        act: () => setPanel({ kind: "shelf", query: words }),
      };
      if (!query || "skill browse compose".includes(query) || scoped) items.push(browse);
      return items;
    },
    [shelf, draft.document.name],
  );

  // The keyboard's way to the shelf, from anywhere in the Studio.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setPanel((p) => (p?.kind === "shelf" ? null : { kind: "shelf" }));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const closePanel = useCallback(() => {
    setPanel(null);
    editor.current?.focus();
  }, [editor]);

  const openSkill = useCallback(
    (s: ShelfSkill) => {
      setInspector(null);
      if (s.origin === "mine") return navigate({ name: "skills", skillId: s.key.replace(/^mine:/, "") });
      if (s.origin === "machine") return navigate({ name: "skills", tab: "machine" });
      if (s.origin === "library" || s.origin === "community") {
        const [sourceId, ...rest] = s.key.replace(/^library:/, "").split("/");
        return navigate({ name: "sources", sourceId, itemId: rest.join("/") });
      }
      const projectOf = s.key.replace(/^project:/, "").split("/")[0];
      if (projectOf) navigate({ name: "project", projectId: projectOf, tab: "workbench" });
    },
    [navigate],
  );

  const liveTokens = Math.ceil(draft.document.body.length / 4);

  const panelNode: ReactNode =
    panel?.kind === "shelf" ? (
      <Shelf
        skills={shelf}
        loading={shelfQuery.isLoading}
        initialQuery={panel.query}
        currentName={draft.document.name}
        title={panel.replace ? "Use another skill" : "Use a skill"}
        note={
          panel.replace
            ? panel.replace.all
              ? `Replaces ${titleOf(panel.replace.name)} everywhere on this page.`
              : `Replaces ${titleOf(panel.replace.name)} in this one place.`
            : undefined
        }
        onPick={pick}
        onClose={closePanel}
      />
    ) : panel?.kind === "overview" ? (
      <Overview
        overview={view ? overviewOf(view.state.doc) : { rows: [], names: [], uses: [] }}
        composition={composition.data}
        titleOf={titleOf}
        onGo={(pos) => {
          const dom = view?.nodeDOM(pos);
          if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "start", behavior: "smooth" });
        }}
        onUse={openUse}
        onAddBack={(name) => {
          const current = withView();
          if (!current) return;
          editor.current?.appendMarkdown(sentenceFor("alongside", mentionOf(name)));
          const hit = occurrencesIn(current.state.doc)
            .filter((o) => o.name === name)
            .pop();
          if (hit) current.dispatch(current.state.tr.setNodeAttribute(hit.pos, "role", "alongside"));
        }}
        onForget={(name) => {
          hadChip.current.add(name);
          const next = draft.composes.filter((e) => e.skill !== name);
          loaded.current = next;
          draft.setComposes(next);
        }}
        onClose={closePanel}
      />
    ) : panel?.kind === "inside" ? (
      <Inside
        composition={composition.data}
        liveInstructionsTokens={liveTokens}
        ready={ready}
        problems={problems}
        onOpenFile={onOpenFile}
        onWhen={onWhen}
        onReadiness={onReadiness}
        onSource={onSource}
        onOverview={() => setPanel({ kind: "overview" })}
        onClose={closePanel}
      />
    ) : null;

  const inspectorNode: ReactNode = inspector ? (
    <RefInspector
      target={inspector}
      dependency={deps.get(inspector.name)}
      shelf={byName.get(inspector.name) ?? []}
      onRole={(role: RoleId) => {
        const current = withView();
        if (!current) return;
        const reworded = canReword(current, inspector.pos);
        setRole(current, inspector.pos, role);
        if (reworded) {
          setInspector(null);
          current.focus();
        } else setInspector({ ...inspector, role });
      }}
      onMakePart={() => {
        const current = withView();
        if (!current) return;
        const s = byName.get(inspector.name)?.[0];
        promote(current, inspector.pos, s ? pickOf(s).from : null);
        setInspector({ ...inspector, role: "used" });
      }}
      onRemove={() => {
        const current = withView();
        if (!current) return;
        removeUse(current, inspector.pos);
        setInspector(null);
        current.focus();
        toast.show(`${titleOf(inspector.name)} removed from here. ⌘Z brings it back.`);
      }}
      onReplace={(all) => {
        setPanel({ kind: "shelf", replace: { pos: inspector.pos, name: inspector.name, all } });
        setInspector(null);
      }}
      onJump={(pos) => {
        const current = withView();
        if (current) selectUse(current, pos);
        setInspector(null);
      }}
      onOpenSkill={openSkill}
      onConnect={(url) => {
        setInspector(null);
        void navigator.clipboard?.writeText(url).catch(() => undefined);
        toast.show(`Its address is copied: ${url}. Paste it to connect the library, and review it there.`);
        navigate({ name: "sources", view: "git" });
      }}
      onFind={() => {
        setPanel({
          kind: "shelf",
          query: inspector.name.replace(/-/g, " "),
          replace: { pos: inspector.pos, name: inspector.name, all: false },
        });
        setInspector(null);
      }}
      onClose={closeInspector}
    />
  ) : null;

  const threads: ReactNode = (
    <Threads
      view={view}
      tick={tick}
      look={look}
      onOpen={openUse}
      expanded={panel?.kind === "overview"}
      onOverview={() => setPanel((p) => (p?.kind === "overview" ? null : { kind: "overview" }))}
    />
  );

  const liveComposes = useCallback(() => {
    const current = editor.current?.view();
    return current ? derived(current.state.doc) : loaded.current;
  }, [editor, derived]);

  return {
    panel,
    setPanel,
    panelNode,
    inspectorNode,
    threads,
    context,
    slashExtras,
    annotate,
    onSettled,
    liveComposes,
    /** How many skills this one is deliberately made of. */
    used: composition.data?.dependencies.length ?? 0,
    canon: canonOf,
  };
}

export type Composer = ReturnType<typeof useComposer>;
