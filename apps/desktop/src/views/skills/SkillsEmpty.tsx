/**
 * My skills, before the first skill: what a skill is, shown as the file it
 * becomes, and the two ways to get one. The specimen is a real SKILL.md in
 * miniature; pointing at a note in the legend lights the lines it explains,
 * so a first-time visitor learns the format without reading documentation.
 */
import { type CSSProperties, type ReactNode, useState } from "react";
import type { SkillTemplate } from "../../bindings/SkillTemplate";
import { Icon, type IconName } from "../../components/Icon";
import { Button, Kbd } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { slugify } from "../../lib/skills";
import type { AddSkillsStart } from "./AddSkillsDialog";

type Part = "name" | "when" | "steps";

const NOTES: { part: Part; label: string; text: string }[] = [
  { part: "name", label: "Name", text: "What you would call it. Lowercase, with hyphens." },
  { part: "when", label: "When", text: "The cue that tells an agent this skill applies." },
  { part: "steps", label: "Steps", text: "What to do, in plain Markdown. As short as it can be." },
];

const WAYS: { label: string; icon: IconName; start: AddSkillsStart }[] = [
  { label: "A project", icon: "layers", start: { source: "choose" } },
  { label: "A folder", icon: "folder", start: { source: "folder" } },
  { label: "A Git repository", icon: "branch", start: { source: "git" } },
];

/**
 * Common things teams write down. Each opens the new-skill dialog already filled in.
 * Add or remove entries freely: the row reflows to 2, 3 or 6 columns (keep a multiple of 6 or 3 for a tidy end).
 */
const IDEAS: { title: string; template: SkillTemplate; kind: string; bars: number[] }[] = [
  {
    title: "Review a pull request",
    template: "reviewProcedure",
    kind: "Review procedure",
    bars: [9, 14, 11, 6],
  },
  {
    title: "Ship a release",
    template: "implementationGuide",
    kind: "Implementation guide",
    bars: [12, 8, 13, 7],
  },
  {
    title: "Add an API endpoint",
    template: "implementationGuide",
    kind: "Implementation guide",
    bars: [7, 13, 9, 12],
  },
  {
    title: "Triage a flaky test",
    template: "reviewProcedure",
    kind: "Review procedure",
    bars: [13, 7, 12, 9],
  },
  {
    title: "Write a migration",
    template: "implementationGuide",
    kind: "Implementation guide",
    bars: [8, 12, 7, 13],
  },
  {
    title: "Review a dependency update",
    template: "reviewProcedure",
    kind: "Review procedure",
    bars: [11, 9, 14, 8],
  },
];

/** One line of the specimen; `part` ties it to a legend note. */
function Line({
  n,
  part,
  lit,
  children,
}: {
  n: number;
  part: Part | null;
  lit: Part | null;
  children?: ReactNode;
}) {
  return (
    <span
      className={`specimen-line${part && part === lit ? " is-lit" : ""}${lit && part !== lit ? " is-dim" : ""}`}
      style={{ "--i": n } as CSSProperties}
    >
      <span className="specimen-gutter" aria-hidden="true">
        {n}
      </span>
      <span className="specimen-code">{children ?? " "}</span>
    </span>
  );
}

export function SkillsEmpty() {
  const { newSkill, addSkills } = useActions();
  const [lit, setLit] = useState<Part | null>(null);
  const point = (part: Part | null) => ({
    onMouseEnter: () => setLit(part),
    onMouseLeave: () => setLit(null),
    onFocus: () => setLit(part),
    onBlur: () => setLit(null),
  });

  return (
    <div className="skills-empty">
      <section className="skills-stage" aria-labelledby="skill-anatomy">
        <p className="kicker" id="skill-anatomy">
          What is a skill?
        </p>
        <h2 className="skills-stage-title">
          A note your agent can follow, <em>kept as a file.</em>
        </h2>

        <div className="specimen" aria-hidden="true">
          <div className="specimen-selvedge" />
          <div className="specimen-bar">
            <Icon name="file" size={14} />
            <span>SKILL.md</span>
            <span className="specimen-tag">draft</span>
          </div>
          <pre className="specimen-body">
            <Line n={1} part={null} lit={lit}>
              <span className="tok-punct">---</span>
            </Line>
            <Line n={2} part="name" lit={lit}>
              <span className="tok-key">name</span>
              <span className="tok-punct">: </span>
              review-migrations
            </Line>
            <Line n={3} part="when" lit={lit}>
              <span className="tok-key">description</span>
              <span className="tok-punct">: </span>
              Use when a PR adds a migration.
            </Line>
            <Line n={4} part={null} lit={lit}>
              <span className="tok-punct">---</span>
            </Line>
            <Line n={5} part="steps" lit={lit}>
              <span className="tok-head"># Review a migration</span>
            </Line>
            <Line n={6} part="steps" lit={lit} />
            <Line n={7} part="steps" lit={lit}>
              <span className="tok-punct">1.</span> Confirm it can be rolled back.
            </Line>
            <Line n={8} part="steps" lit={lit}>
              <span className="tok-punct">2.</span> Look for locks on large tables.
            </Line>
            <Line n={9} part="steps" lit={lit}>
              <span className="tok-punct">3.</span> Try it on a copy first.
            </Line>
          </pre>
        </div>

        <ol className="skills-notes">
          {NOTES.map((note, i) => (
            <li key={note.part}>
              <button
                type="button"
                className={`skills-note${lit === note.part ? " is-lit" : ""}`}
                aria-pressed={lit === note.part}
                {...point(note.part)}
              >
                <span className="skills-note-n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="skills-note-label">{note.label}</span>
                <span className="skills-note-text">{note.text}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <div className="skills-ways">
        <section className="skills-way is-primary">
          <p className="kicker">Start fresh</p>
          <h2 className="skills-way-title">Write a skill</h2>
          <p className="skills-way-text">
            Something your team keeps explaining — a review routine, a migration recipe. A title is enough to
            start; Habi lays out the file.
          </p>
          <div className="skills-way-act">
            <Button variant="primary" icon="pencil" onClick={() => newSkill()}>
              Create a skill
            </Button>
            <span className="skills-way-key">
              <Kbd>⌘N</Kbd>
            </span>
          </div>
        </section>

        <p className="skills-or" aria-hidden="true">
          <span>or</span>
        </p>

        <section className="skills-way">
          <p className="kicker">Already have some?</p>
          <h2 className="skills-way-title">Bring them in</h2>
          <p className="skills-way-text">
            Copy skills from where they live. Habi inspects everything before it copies a single file.
          </p>
          <ul className="skills-sources" aria-label="Where to add skills from">
            {WAYS.map((way) => (
              <li key={way.label}>
                <button type="button" className="skills-source" onClick={() => addSkills(way.start)}>
                  <Icon name={way.icon} />
                  {way.label}
                  <Icon name="chevronRight" size={14} className="skills-source-go" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="skills-ideas" aria-labelledby="skill-ideas">
        <p className="kicker" id="skill-ideas">
          Or start from an idea
        </p>
        <ul className="skills-idea-list">
          {IDEAS.map((idea) => (
            <li key={idea.title}>
              <button
                type="button"
                className="skills-idea"
                onClick={() => newSkill({ title: idea.title, template: idea.template })}
              >
                <span className="skills-idea-bars" aria-hidden="true">
                  {idea.bars.map((w, i) => (
                    <span key={i} style={{ width: `${w * 6}%`, background: `var(--dye-${(i * 2) % 8})` }} />
                  ))}
                </span>
                <span className="skills-idea-title">{idea.title}</span>
                <span className="skills-idea-slug">{slugify(idea.title)}</span>
                <span className="skills-idea-kind">{idea.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="skills-unwoven" aria-hidden="true">
        <span className="skills-unwoven-weft" />
        <span className="skills-unwoven-note">your first skill is the first thread</span>
      </div>
    </div>
  );
}
