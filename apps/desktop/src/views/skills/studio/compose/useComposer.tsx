/**
 * Everything composing needs, in one place the Studio can hold: what's on the
 * shelf, what the skill is composed of, and which panel or inspector is open.
 * The document remains the truth; this only reads it and asks it to change.
 */
import { useQuery } from "@tanstack/react-query";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShelfSkill } from "../../../../bindings/ShelfSkill";
import { useToast } from "../../../../components/Toasts";
import { api } from "../../../../lib/api";
import { useNav } from "../../../../lib/nav";
import { sliceFromMarkdown } from "../doc/commands";
import { armDrag, ghostLabel } from "../doc/drag";
import { markdownForFile } from "../doc/fileRefs";
import type { DocEditorHandle } from "../doc/lazy";
import { canonOf } from "../doc/markdown/canon";
import { parseBody } from "../doc/markdown/parse";
import { moveBlocks, placeBlocks, sectionRange, topBlockAt } from "../doc/moves";
import { LOOKS_CHANGED, type SkillLook, type ViewContext } from "../doc/nodeViews";
import type { SlashItem } from "../doc/SlashMenu";
import type { SkillDraft } from "../useSkillDraft";
import {
  canReword,
  dropSkillBetween,
  dropSkillInText,
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
import { KNOT, titleOfName } from "./knots";
import { Overview } from "./Overview";
import { endOfRow, overviewOf } from "./overviewData";
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

export type Panel =
  | { kind: "shelf"; query?: string; inline?: boolean; replace?: { pos: number; name: string; all: boolean } }
  | { kind: "overview" }
  | { kind: "inside" }
  /** Drawn by the Studio, which holds what it needs. */
  | { kind: "when" };

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
  onAddFile,
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
  /** Lets the author choose a file to bring into the skill, at the caret. */
  onAddFile: () => void;
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
    (name: string): SkillLook["status"] => {
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

  /** Carries a skill from the shelf to the page, trailing a thread from the margin. */
  const liftSkill = useCallback(
    (s: ShelfSkill, event: PointerEvent) => {
      armDrag(event, () => {
        const current = withView();
        if (!current) return null;
        const color = KNOT;
        return {
          view: current,
          ghost: ghostLabel(s.title, color),
          grip: { x: 18, y: 15 },
          inline: true,
          tether: () => ({ x: current.dom.getBoundingClientRect().right + 28, color }),
          onLand: (landing) => {
            if (landing.type === "text") dropSkillInText(current, pickOf(s), landing.pos);
            else if (landing.type === "slot") dropSkillBetween(current, pickOf(s), landing.slot.pos);
            current.focus();
          },
        };
      });
    },
    [withView],
  );

  /** Picks up a knot in the margin: along the thread moves its sentence, away from it takes it out. */
  const liftKnot = useCallback(
    (pos: number, event: PointerEvent) => {
      armDrag(event, () => {
        const current = withView();
        if (!current) return null;
        const chip = current.state.doc.nodeAt(pos);
        const range = topBlockAt(current.state.doc, pos);
        if (!chip || !range) return null;
        const name = chip.attrs.name as string;
        // A short way off the thread, measured from where it was: it works at any window width.
        const pullAt = event.clientX + 64;
        return {
          view: current,
          ghost: ghostLabel(titleOf(name), KNOT),
          grip: { x: 18, y: 15 },
          source: range,
          pulls: (x) => x > pullAt,
          onLand: (landing) => {
            if (landing.type === "pull") {
              removeUse(current, pos);
              toast.show(`${titleOf(name)} taken out. ⌘Z brings it back.`);
            } else if (landing.type === "slot") {
              moveBlocks(current, range.from, range.to, landing.slot.pos);
            }
            current.focus();
          },
        };
      });
    },
    [withView, titleOf, toast],
  );

  /** Carries one of the skill's files to the page: it joins a sentence, or gets a line of its own. */
  const liftFile = useCallback(
    (path: string, name: string, event: PointerEvent) => {
      armDrag(event, () => {
        const current = withView();
        if (!current) return null;
        return {
          view: current,
          ghost: ghostLabel(name),
          grip: { x: 18, y: 15 },
          inline: true,
          onLand: (landing) => {
            const markdown = markdownForFile(path);
            if (landing.type === "text") {
              const tr = current.state.tr.setSelection(TextSelection.create(current.state.doc, landing.pos));
              current.dispatch(tr.replaceSelection(sliceFromMarkdown(markdown)));
            } else if (landing.type === "slot") {
              const doc = parseBody(markdown).doc;
              const blocks: PMNode[] = [];
              doc.forEach((child) => {
                blocks.push(child);
              });
              placeBlocks(current, landing.slot.pos, blocks);
            }
            current.focus();
          },
        };
      });
    },
    [withView],
  );

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
      }),
      onSkillClick: (name, pos, rect) => openInspector(name, pos, rect),
      onLiftUse: (pos, event) => liftKnot(pos, event),
      onLinkSkill: (query) => setPanel({ kind: "shelf", query, inline: true }),
      onChoosePiece: (what) => {
        if (what === "skill") setPanel({ kind: "shelf", inline: false });
        else onAddFile();
      },
    }),
    [titleOf, statusOf, openInspector, onAddFile, liftKnot],
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
        title={panel.replace ? "Link another skill" : "Link a skill"}
        note={
          panel.replace
            ? panel.replace.all
              ? `Replaces ${titleOf(panel.replace.name)} everywhere on this page.`
              : `Replaces ${titleOf(panel.replace.name)} in this one place.`
            : undefined
        }
        onPick={pick}
        onLift={panel.replace ? undefined : liftSkill}
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
        onTie={(name, row) => {
          const current = withView();
          if (!current) return;
          const at = endOfRow(current.state.doc, overviewOf(current.state.doc), row);
          const s = byName.get(name)?.[0];
          dropSkillBetween(current, s ? pickOf(s) : { name }, at);
        }}
        onMoveUse={(pos, row) => {
          const current = withView();
          if (!current) return;
          const range = topBlockAt(current.state.doc, pos);
          if (!range) return;
          moveBlocks(
            current,
            range.from,
            range.to,
            endOfRow(current.state.doc, overviewOf(current.state.doc), row),
          );
        }}
        onMoveSection={(row, before) => {
          const current = withView();
          if (!current) return;
          const data = overviewOf(current.state.doc);
          const here = data.rows[row];
          if (!here) return;
          const range = sectionRange(current.state.doc, here.pos);
          if (!range) return;
          const target = data.rows[before]?.pos ?? current.state.doc.content.size;
          moveBlocks(current, range.from, range.to, target);
        }}
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
        titleOf={titleOf}
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

  const others = useMemo(
    () =>
      (composition.data?.dependencies ?? []).map((d) => ({
        name: d.name,
        title: titleOf(d.name),
        status: statusOf(d.name),
      })),
    [composition.data, titleOf, statusOf],
  );

  /** Goes to where a skill is linked, and opens it there. */
  const showUse = useCallback(
    (name: string) => {
      const current = withView();
      const use = current && occurrencesIn(current.state.doc).find((o) => o.name === name);
      if (use) openUse(use.pos);
    },
    [withView, openUse],
  );

  const liveComposes = useCallback(() => {
    const current = editor.current?.view();
    return current ? derived(current.state.doc) : loaded.current;
  }, [editor, derived]);

  return {
    panel,
    setPanel,
    panelNode,
    liftFile,
    inspectorNode,
    context,
    slashExtras,
    annotate,
    onSettled,
    liveComposes,
    others,
    showUse,
    /** How many skills this one is deliberately made of. */
    used: composition.data?.dependencies.length ?? 0,
    canon: canonOf,
  };
}

export type Composer = ReturnType<typeof useComposer>;
