/**
 * The kit: Habi's short answer to "what should my agents have here?".
 *
 * Every suggestion is a knot on one thread, with the reason it fits and the
 * library it comes from. Libraries not connected yet are connected when the
 * person adds their skills (read only, nothing runs), and adding always ends
 * in the usual review: agents, every file, confirm.
 */
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import type { ItemRef } from "../../bindings/ItemRef";
import type { Kit as KitData } from "../../bindings/Kit";
import type { KitGroup } from "../../bindings/KitGroup";
import type { LibraryIndex } from "../../bindings/LibraryIndex";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import type { Suggestion } from "../../bindings/Suggestion";
import { Icon } from "../../components/Icon";
import { Button, ErrorNotice } from "../../components/ui";
import { Strand } from "../../components/Weave";
import { Weaving } from "../../components/Weaving";
import { useActions } from "../../lib/actions";
import { api, HabiError, newJobId } from "../../lib/api";
import { type Dye, useDyes } from "../../lib/dye";
import { andList, plural } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { invalidateProjectData, keys, useMachineSkills } from "../../lib/queries";
import { summarize } from "../../lib/skillFacts";
import { ReviewDialog } from "../review/ReviewDialog";
import { SIGNALS_LIMIT } from "../sources/Signals";

const SECTIONS: { group: KitGroup; title: string }[] = [
  { group: "required", title: "Your team requires" },
  { group: "stack", title: "For this stack" },
  { group: "practice", title: "For how you work" },
];

const COST_TIP =
  "Agents load every installed skill's name and description at the start of each session. Its full instructions load only when it is used. An estimate, about 4 characters to a token.";

/** A library that is not connected yet: a loose, undyed thread. */
const LOOSE: Dye = { color: "var(--ink-faint)", community: true };

/**
 * Who stands behind the reason, when it is not Habi's pick (the kit is
 * Habi's picks unless a row says otherwise).
 */
export function basisWord(s: Suggestion): string | null {
  if (s.group === "required") return "Team requirement";
  if (s.pick || !s.applicability) return null;
  switch (s.basis) {
    case "declared":
      return "Author's rule";
    case "catalogHint":
      return "Habi's rule";
    case "described":
      return "From its description";
  }
}

/** Why it fits, in one line: the evaluation's reason, or Habi's stance for a practice. */
export function reasonOf(s: Suggestion): string {
  if (s.applicability && s.applicability.applicability === "applies") return s.applicability.reason;
  return s.pick ?? "";
}

type Phase =
  | { step: "idle" }
  | { step: "connecting"; name: string; at: number; of: number; job: string }
  | { step: "reading" }
  | { step: "reviewing"; items: ItemRef[] }
  | { step: "failed"; error: unknown; during: "connecting" | "reading" }
  | { step: "stopped" };

/**
 * The item a chosen suggestion is, once its library is connected: from the
 * fresh kit, or from the library itself when the kit no longer lists it (a
 * connected library can bring skills that take its place).
 */
async function resolve(
  s: Suggestion,
  fresh: ProjectOverview,
  libraries: Map<string, Promise<LibraryIndex>>,
): Promise<ItemRef | "installed" | null> {
  const now = fresh.kit.suggestions.find((x) => x.key === s.key);
  if (now?.installed) return "installed";
  if (now?.item) return now.item;
  if (s.item) return s.item;
  const source = fresh.sources.find((src) => src.catalogId === s.library.entryId);
  if (!source || !s.library.entryId) return null;
  let library = libraries.get(source.id);
  if (!library) {
    library = api.library(source.id);
    libraries.set(source.id, library);
  }
  const prefix = `catalog:${s.library.entryId}/`;
  const item = (await library).items.find((i) => `${prefix}${i.path}` === s.key);
  return item ? { sourceId: source.id, itemId: item.id } : null;
}

export function Kit({
  overview,
  onAll,
  ticks,
}: {
  overview: ProjectOverview;
  onAll: () => void;
  /** Held by the project page, so unticking survives reading a skill and coming back. */
  ticks?: [Set<string>, Dispatch<SetStateAction<Set<string>>>];
}) {
  const { project } = overview;
  const client = useQueryClient();
  const dyes = useDyes();
  const { navigate } = useNav();
  const { newSkill } = useActions();
  // Skills already in the person's own folders reach every project: adding a copy here is a choice, not a default.
  const machine = useMachineSkills();
  const onMachine = new Set((machine.data ?? []).map((m) => m.name.toLowerCase()));
  const everywhere = (s: Suggestion) => !s.installed && onMachine.has(s.name.toLowerCase());

  // While skills are being added the kit holds still: what was chosen is what is added. After an
  // install it shows them as added until the project has been read again.
  const [frozen, setFrozen] = useState<{ kit: KitData; until: ProjectOverview | null } | null>(null);
  useEffect(() => {
    if (frozen?.until && overview !== frozen.until) setFrozen(null);
  }, [overview, frozen]);
  const kit = frozen?.kit ?? overview.kit;

  // What Habi ticks to start with, except copies of skills already on this machine; a knot flips that.
  const own = useState<Set<string>>(() => new Set());
  const [flipped, setFlipped] = ticks ?? own;
  const isOn = (s: Suggestion) => !s.installed && flipped.has(s.key) !== (s.chosen && !everywhere(s));
  const open = kit.suggestions.filter((s) => !s.installed);
  const chosen = open.filter(isOn);
  const cost = chosen.reduce((sum, s) => sum + s.tokens, 0);
  const toConnect = [
    ...new Map(
      chosen
        .filter((s) => !s.library.connected && s.library.entryId)
        .map((s) => [s.library.entryId as string, s.library.name]),
    ).entries(),
  ].map(([entryId, name]) => ({ entryId, name }));

  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [missing, setMissing] = useState<string[]>([]);
  const adding = useRef<string[]>([]);
  const job = useRef<string | null>(null);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      // Leaving stops the work: nothing more is connected, and no review opens on another page.
      mounted.current = false;
      cancelled.current = true;
      if (job.current) void api.cancelJob(job.current);
    };
  }, []);

  // Focus follows the work: to Cancel while it runs, back to the button after.
  const cart = useRef<HTMLElement>(null);
  const busy = phase.step === "connecting" || phase.step === "reading";
  const wasBusy = useRef(false);
  useEffect(() => {
    const focus = (selector: string) => cart.current?.querySelector<HTMLElement>(selector)?.focus();
    if (phase.step === "connecting" && !wasBusy.current) focus(".weaving button");
    if (!busy && wasBusy.current && phase.step !== "reviewing") focus(".kit-go");
    wasBusy.current = busy;
  }, [phase.step, busy]);

  const toggle = (key: string) =>
    setFlipped((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const add = async () => {
    const picked = chosen;
    adding.current = picked.map((s) => s.key);
    cancelled.current = false;
    setMissing([]);
    setFrozen({ kit, until: null });
    const stop = () => {
      throw new HabiError({ code: "cancelled", message: "Stopped before adding." });
    };
    let during: "connecting" | "reading" = "connecting";
    const items: ItemRef[] = [];
    const lost: string[] = [];
    try {
      for (const [i, library] of toConnect.entries()) {
        if (cancelled.current) stop();
        const id = newJobId();
        job.current = id;
        setPhase({ step: "connecting", name: library.name, at: i + 1, of: toConnect.length, job: id });
        await api.connectCatalogEntry(library.entryId, id);
        job.current = null;
      }
      if (cancelled.current) stop();
      during = "reading";
      let fresh = overview;
      if (toConnect.length > 0) {
        setPhase({ step: "reading" });
        // New libraries change what fits every project; this one is read once, now.
        invalidateProjectData(client);
        fresh = await client.fetchQuery({
          queryKey: keys.overview(project.id),
          queryFn: () => api.projectOverview(project.id, false),
        });
      }
      const libraries = new Map<string, Promise<LibraryIndex>>();
      for (const s of picked) {
        const found = await resolve(s, fresh, libraries);
        if (found === null) lost.push(s.title);
        else if (found !== "installed") items.push(found);
      }
    } catch (error) {
      job.current = null;
      if (!mounted.current) return;
      setFrozen(null);
      // What was connected before it stopped stays connected; the kit shows it.
      invalidateProjectData(client);
      const stopped = cancelled.current || (error instanceof HabiError && error.code === "cancelled");
      setPhase(stopped ? { step: "stopped" } : { step: "failed", error, during });
      return;
    }
    if (!mounted.current || cancelled.current) return;
    setMissing(lost);
    if (items.length > 0) setPhase({ step: "reviewing", items });
    else {
      setPhase({ step: "idle" });
      setFrozen(null);
    }
  };

  const cancel = () => {
    cancelled.current = true;
    if (job.current) void api.cancelJob(job.current);
  };

  const look = (s: Suggestion) => {
    if (s.item) {
      navigate({
        name: "project",
        projectId: project.id,
        tab: "workbench",
        itemKey: `${s.item.sourceId}/${s.item.itemId}`,
      });
    } else if (s.library.entryId) {
      navigate({ name: "sources", entry: s.library.entryId });
    }
  };

  const empty = kit.suggestions.length === 0;
  const done = !empty && open.length === 0;

  return (
    <div className="kit">
      <div className="kit-grid">
        <div className="kit-list">
          <header className="kit-lead">
            <h2 className="kit-headline">
              {empty
                ? `Nothing to suggest for ${project.name} yet`
                : done
                  ? `${project.name} has everything Habi suggests`
                  : `${plural(open.length, "skill")} for ${project.name}`}
            </h2>
            <p className="kit-sub">
              {empty
                ? "Habi found nothing it would pick for this project. Explore libraries, or write a skill of your own."
                : done
                  ? "New suggestions appear when the project, your libraries or your other projects change."
                  : "Habi's picks for what it read in this repository, each with the reason it fits. The strongest few start ticked."}
            </p>
          </header>

          {SECTIONS.map(({ group, title }) => {
            const rows = kit.suggestions.filter((s) => s.group === group);
            if (rows.length === 0) return null;
            return (
              <section key={group} className="kit-section" aria-label={title}>
                <h3 className="kit-section-title">{title}</h3>
                <ul className="kit-rows">
                  {rows.map((s, i) => {
                    const on = isOn(s);
                    const dye = s.library.sourceId ? dyes(s.library.sourceId) : LOOSE;
                    const reason = reasonOf(s);
                    const basis = basisWord(s);
                    return (
                      <li
                        key={s.key}
                        className={`kit-row${on ? " is-on" : ""}${s.installed ? " is-added" : ""}`}
                        style={{ "--i": i } as CSSProperties}
                      >
                        <label
                          className="kit-knot"
                          data-tip={s.installed ? undefined : on ? "Leave out" : "Add"}
                        >
                          <input
                            type="checkbox"
                            checked={on || s.installed}
                            disabled={s.installed || busy}
                            onChange={() => toggle(s.key)}
                            aria-label={
                              s.installed ? `${s.title}, already in ${project.name}` : `Add ${s.title}`
                            }
                          />
                          <span className="kit-knot-mark" aria-hidden="true">
                            {s.installed || on ? <Icon name="check" size={11} /> : null}
                          </span>
                        </label>
                        <div className="kit-main">
                          <div className="kit-top">
                            <button type="button" className="kit-title" onClick={() => look(s)}>
                              {s.title}
                            </button>
                            {s.installed ? <span className="kit-added">Added</span> : null}
                            {everywhere(s) ? (
                              <span
                                className="kit-basis"
                                data-tip="Already in your own skill folders, which your agents read in every project"
                              >
                                On this machine
                              </span>
                            ) : null}
                            <span
                              className="kit-from"
                              data-tip={
                                s.library.connected
                                  ? `${s.library.name} — connected`
                                  : `${s.library.name} — not connected yet; adding connects it (read only)`
                              }
                            >
                              <Strand dye={dye} size={13} />
                              {s.library.name}
                            </span>
                          </div>
                          {s.gist ? (
                            <p className="kit-gist">{s.pick ? s.gist : summarize(s.gist).text}</p>
                          ) : null}
                          <p className="kit-why">
                            {reason ? <span className="kit-why-text">{reason}</span> : null}
                            {s.elsewhere.length > 0 ? (
                              <span className="kit-elsewhere">
                                {reason ? "Also in" : "In"} {andList(s.elsewhere)}
                              </span>
                            ) : null}
                            {basis ? <span className="kit-basis">{basis}</span> : null}
                            {s.caution[0] ? (
                              <span
                                className="kit-caution"
                                data-tip={`${s.caution.join(". ")}. ${SIGNALS_LIMIT}`}
                              >
                                <Icon name="warning" size={12} />
                                {s.caution[0]}
                                {s.caution.length > 1 ? ` and ${s.caution.length - 1} more` : ""}
                              </span>
                            ) : null}
                            {s.scripts ? (
                              <span
                                className="kit-basis"
                                data-tip="Your agent can run this code. The review shows every file."
                              >
                                Comes with scripts
                              </span>
                            ) : null}
                            <span className="kit-cost" data-tip={COST_TIP}>
                              ~{s.tokens} tokens
                            </span>
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          <footer className="kit-foot">
            {kit.more > 0 ? (
              <button type="button" className="kit-link" onClick={onAll}>
                {plural(kit.more, "more skill")} from your libraries {kit.more === 1 ? "fits" : "fit"}
                <Icon name="chevronRight" size={12} />
              </button>
            ) : null}
            {empty ? (
              <button
                type="button"
                className="kit-link"
                onClick={() => navigate({ name: "sources", view: "explore" })}
              >
                Explore libraries
                <Icon name="chevronRight" size={12} />
              </button>
            ) : null}
            <button
              type="button"
              className="kit-link"
              onClick={() => newSkill({ projectId: project.id, projectName: project.name })}
            >
              Write a skill for how {project.name} works
              <Icon name="chevronRight" size={12} />
            </button>
          </footer>
        </div>

        {empty || done ? null : (
          <aside className="kit-cart" aria-label={`Add to ${project.name}`} ref={cart}>
            <p className="kit-cart-count">
              {chosen.length === 0 ? "Nothing chosen" : plural(chosen.length, "skill")}
            </p>
            {chosen.length > 0 ? (
              <p className="kit-cart-note" data-tip={COST_TIP}>
                About {cost.toLocaleString("en")} tokens in every agent session.
              </p>
            ) : null}
            {toConnect.length > 0 ? (
              <div className="kit-connects">
                <p className="kit-cart-note">
                  Connects {toConnect.length === 1 ? "this library" : `these ${toConnect.length} libraries`}{" "}
                  first. Read only, nothing runs.
                </p>
                <ul className="kit-threads">
                  {toConnect.map((l) => (
                    <li
                      key={l.entryId}
                      className={phase.step === "connecting" && phase.name === l.name ? "is-now" : undefined}
                    >
                      <Strand dye={LOOSE} size={13} />
                      {l.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {phase.step === "connecting" ? (
              <Weaving
                slim
                label={`Connecting ${phase.name}${phase.of > 1 ? ` (${phase.at} of ${phase.of})` : ""}`}
                onCancel={cancel}
              />
            ) : phase.step === "reading" ? (
              <Weaving slim label="Finding the skills in what was connected" />
            ) : (
              <Button
                variant="primary"
                className="kit-go"
                disabled={chosen.length === 0}
                onClick={() => void add()}
              >
                {chosen.length === 0 ? "Choose skills to add" : "Review and add…"}
              </Button>
            )}
            {phase.step === "stopped" ? (
              <p className="kit-cart-note" role="status">
                Stopped. Libraries already connected stay connected; nothing was installed.
              </p>
            ) : null}
            {phase.step === "failed" ? (
              <ErrorNotice
                error={phase.error}
                title={
                  phase.during === "connecting"
                    ? "A library could not be connected"
                    : "The connected libraries could not be read"
                }
              />
            ) : null}
            {missing.length > 0 ? (
              <p className="kit-cart-note is-warn" role="status">
                Not found in {missing.length === 1 ? "its library" : "their libraries"}: {andList(missing)}.
              </p>
            ) : null}
            <p className="kit-cart-note">
              You choose the agents and see every file before anything is written.
            </p>
          </aside>
        )}
      </div>

      {phase.step === "reviewing" ? (
        <ReviewDialog
          projectId={project.id}
          request={{
            kind: "install",
            items: phase.items,
            title: plural(phase.items.length, "skill"),
          }}
          onApplied={() => {
            const added = new Set(adding.current);
            setFrozen({
              kit: {
                ...kit,
                suggestions: kit.suggestions.map((s) => (added.has(s.key) ? { ...s, installed: true } : s)),
              },
              until: overview,
            });
            setFlipped(new Set());
          }}
          onClose={() => {
            setPhase({ step: "idle" });
            // Closed without installing: back to the live kit, with the person's choices kept.
            setFrozen((f) => (f?.until ? f : null));
          }}
        />
      ) : null}
    </div>
  );
}
