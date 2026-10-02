/**
 * When Habi should suggest the skill: sentences by default, the YAML as
 * written for those who prefer it. Both edit the same habi.yaml; switching
 * saves first and reads back what was saved. Rules the builder cannot express
 * are shown as sentences, read-only, and never rewritten. Without rules a
 * skill is still complete — it is simply used by hand.
 */
import type { Condition } from "../../../bindings/Condition";
import type { SkillPreview } from "../../../bindings/SkillPreview";
import { SourceEditor } from "../../../components/lazy";
import { Button } from "../../../components/ui";
import { type ClauseNode, statementsFromCondition } from "../../../lib/applicability";
import { ConditionBuilder, PhraseText } from "../ConditionBuilder";
import type { SkillDraft } from "./useSkillDraft";

function Clause({ node }: { node: ClauseNode }) {
  if (node.op === "leaf") {
    return (
      <li className="rb-row">
        <span className="rb-knot" aria-hidden="true" />
        <span className="rb-text">
          <PhraseText phrase={node.phrase} />
        </span>
      </li>
    );
  }
  const items = node.op === "not" ? [node.item] : node.items;
  return (
    <li className="rb-group">
      <span className="rb-group-label">{node.label}</span>
      <ul className="rb-rows">
        {items.map((child, i) => (
          <Clause key={i} node={child} />
        ))}
      </ul>
    </li>
  );
}

/** Conditions as Habi reads them, whatever their shape. */
export function ReadRules({
  appliesWhen,
  excludes,
}: {
  appliesWhen: Condition | null;
  excludes: Condition | null;
}) {
  if (!appliesWhen && !excludes) {
    return <p className="rb-empty">No conditions — Habi won't suggest it on its own.</p>;
  }
  return (
    <div className="rulebook is-read">
      {appliesWhen ? (
        <section className="rb-section">
          <p className="rb-lead">Suggest this skill when</p>
          <ul className="rb-rows">
            <Clause node={statementsFromCondition(appliesWhen)} />
          </ul>
        </section>
      ) : null}
      {excludes ? (
        <section className="rb-section">
          <p className="rb-lead">Unless</p>
          <ul className="rb-rows">
            <Clause node={statementsFromCondition(excludes)} />
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function RulesMode({
  draft,
  preview,
  suggestFrom,
}: {
  draft: SkillDraft;
  /** The latest evaluation of the rules on screen (saved or not), if any. */
  preview: SkillPreview | null;
  suggestFrom: { id: string; name: string } | null;
}) {
  const { form, setForm, yaml, setYaml, yamlMode, switchYaml, trashed, skill } = draft;
  const ruleProblems = skill.diagnostics.filter(
    (d) => d.code === "invalidMetadata" || (d.path !== null && /(^|\/)habi\.ya?ml$/.test(d.path)),
  );
  return (
    <div className="studio-rules">
      <div className="studio-rules-bar">
        <h2 className="studio-rules-title">When should Habi suggest this skill?</h2>
        <fieldset className="studio-switch">
          <legend className="visually-hidden">How to edit the rules</legend>
          <button
            type="button"
            aria-pressed={!yamlMode}
            className={!yamlMode ? "is-on" : undefined}
            onClick={() => void switchYaml(false)}
          >
            Sentences
          </button>
          <button
            type="button"
            aria-pressed={yamlMode}
            className={yamlMode ? "is-on" : undefined}
            onClick={() => void switchYaml(true)}
          >
            YAML
          </button>
        </fieldset>
      </div>

      {yamlMode ? (
        <div className="studio-yaml">
          <SourceEditor
            language="yaml"
            label="habi.yaml"
            value={yaml}
            readOnly={trashed}
            placeholder={"habi: 1\napplies_when:\n  tag: framework:spring-boot"}
            onChange={setYaml}
          />
          <p className="rb-note">
            Saved exactly as typed, including keys Habi does not know. Empty removes the file.
          </p>
          {preview?.problem ? (
            <p className="field-problem" role="alert">
              Habi cannot read these rules yet: {preview.problem}. They are ignored for matching until fixed.
            </p>
          ) : preview ? (
            <div className="studio-reads-as">
              <p className="kicker">Habi reads this as</p>
              <ReadRules appliesWhen={preview.appliesWhen} excludes={preview.excludes} />
            </div>
          ) : null}
        </div>
      ) : skill.metadataStatus === "invalid" ? (
        <div className="studio-rules-note">
          <p className="field-problem" role="alert">
            habi.yaml cannot be read as rules, so it is ignored for matching. Nothing was rewritten.
          </p>
          <ul className="panel-findings">
            {ruleProblems.map((d, i) => (
              <li key={i} className="panel-finding is-error">
                {d.message}
              </li>
            ))}
          </ul>
          <Button size="sm" onClick={() => void switchYaml(true)}>
            Fix it in YAML
          </Button>
        </div>
      ) : form.conditionsEditable ? (
        <fieldset className="builder-fieldset" disabled={trashed}>
          <legend className="visually-hidden">Rules for when Habi suggests this skill</legend>
          <ConditionBuilder form={form} onChange={setForm} suggestFrom={suggestFrom} />
        </fieldset>
      ) : (
        <div className="studio-rules-note">
          <ReadRules appliesWhen={skill.appliesWhen} excludes={skill.excludes} />
          <p className="rb-note">
            Written in YAML with combinations the sentences cannot edit. They are kept exactly as written.{" "}
            <button type="button" className="link-btn" onClick={() => void switchYaml(true)}>
              Edit as YAML
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
