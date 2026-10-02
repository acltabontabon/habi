/** My skills: local drafts and imported, editable copies. */
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useMemo, useState } from "react";
import type { LocalSkillSummary } from "../../bindings/LocalSkillSummary";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Status, Working } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { api } from "../../lib/api";
import { NO_RULES_PHRASE, plural, relativeTime } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { invalidateSkills, useSkills } from "../../lib/queries";
import { originShort } from "../../lib/skills";

const SkillEditor = lazy(() => import("./SkillEditor").then((m) => ({ default: m.SkillEditor })));

function state(s: LocalSkillSummary) {
  if (s.errors > 0) return <Status tone="muted">Draft · {plural(s.errors, "thing")} to finish</Status>;
  if (!s.hasApplicability) return <Status tone="muted">{NO_RULES_PHRASE}</Status>;
  return <Status tone="ok">Has rules for when it applies</Status>;
}

export function SkillsView({ skillId }: { skillId?: string }) {
  const skills = useSkills();
  const { navigate } = useNav();
  const { newSkill, addSkills } = useActions();
  const client = useQueryClient();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [showTrash, setShowTrash] = useState(false);
  const [purging, setPurging] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const all = skills.data ?? [];
  const active = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((s) => s.deletedAt === null)
      .filter(
        (s) =>
          !q ||
          s.title.toLowerCase().includes(q) ||
          s.name.includes(q) ||
          s.description.toLowerCase().includes(q),
      );
  }, [all, query]);
  const trash = all.filter((s) => s.deletedAt !== null);

  if (skillId) {
    return (
      <Suspense fallback={<Working>Opening the skill…</Working>}>
        <SkillEditor key={skillId} id={skillId} />
      </Suspense>
    );
  }
  if (skills.isPending) return <Working>Loading your skills…</Working>;
  if (skills.isError) return <ErrorNotice error={skills.error} />;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await fn();
      invalidateSkills(client);
      toast.show(done);
    } catch (e) {
      setError(e);
    }
  };

  const total = all.length - trash.length;

  return (
    <div className="page skills">
      <header className="skills-head">
        <div>
          <h1 className="page-title">My skills</h1>
          <p className="lead-sm">
            Drafts and editable copies on this machine. They are yours until you install or share them.
          </p>
        </div>
        {total > 0 ? (
          <div className="skills-actions">
            <Button variant="primary" icon="pencil" onClick={() => newSkill()}>
              Create a skill
            </Button>
            <Button icon="plus" onClick={() => addSkills()}>
              Add skills…
            </Button>
          </div>
        ) : null}
      </header>
      {error ? <ErrorNotice error={error} /> : null}

      {total === 0 ? (
        <ul className="welcome-paths skills-start" aria-label="Start your first skill">
          <li>
            <button type="button" className="welcome-path" onClick={() => newSkill()}>
              <Icon name="pencil" />
              <span>
                <span className="welcome-path-title">Create a skill</span>
                <span className="welcome-path-detail">
                  Write down something your team keeps explaining — a review routine, a migration recipe. A
                  title is enough to start.
                </span>
              </span>
            </button>
          </li>
          <li>
            <button type="button" className="welcome-path" onClick={() => addSkills()}>
              <Icon name="plus" />
              <span>
                <span className="welcome-path-title">Add existing skills</span>
                <span className="welcome-path-detail">
                  From a project, a folder, or a Git repository — inspected before anything is copied.
                </span>
              </span>
            </button>
          </li>
        </ul>
      ) : (
        <>
          {total > 6 ? (
            <div className="list-filter skills-filter">
              <Icon name="search" />
              <label className="visually-hidden" htmlFor="skills-filter">
                Filter my skills
              </label>
              <input
                id="skills-filter"
                type="search"
                placeholder="Filter my skills"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : null}
          <ul className="skill-list">
            {active.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="skill-row"
                  onClick={() => navigate({ name: "skills", skillId: s.id })}
                >
                  <span className="skill-row-main">
                    <span className="skill-row-title">{s.title || "Untitled skill"}</span>
                    <span className="skill-row-desc">
                      {s.description || <span className="muted">No description yet</span>}
                    </span>
                  </span>
                  <span className="skill-row-side">
                    {state(s)}
                    <span className="skill-row-meta">
                      {originShort(s.origin)} · edited {relativeTime(s.updatedAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {active.length === 0 ? <p className="muted">No skills match that filter.</p> : null}
        </>
      )}

      {trash.length > 0 ? (
        <section className="skills-trash" aria-labelledby="trash-title">
          <button
            type="button"
            id="trash-title"
            className="link-btn"
            aria-expanded={showTrash}
            onClick={() => setShowTrash((s) => !s)}
          >
            <Icon name={showTrash ? "chevronDown" : "chevronRight"} />
            Trash ({trash.length})
          </button>
          {showTrash ? (
            <ul className="skill-list">
              {trash.map((s) => (
                <li key={s.id} className="trash-row">
                  <span className="skill-row-main">
                    <span className="skill-row-title">{s.title || "Untitled skill"}</span>
                    <span className="skill-row-meta">Moved to the trash {relativeTime(s.deletedAt)}</span>
                  </span>
                  <span className="trash-actions">
                    <Button
                      size="sm"
                      onClick={() => void act(() => api.restoreSkill(s.id), `“${s.title}” restored.`)}
                    >
                      Restore
                    </Button>
                    {purging === s.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            setPurging(null);
                            void act(() => api.purgeSkill(s.id), `“${s.title}” deleted.`);
                          }}
                        >
                          Delete for good
                        </Button>
                        <Button size="sm" variant="quiet" onClick={() => setPurging(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="quiet" onClick={() => setPurging(s.id)}>
                        Delete permanently…
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
