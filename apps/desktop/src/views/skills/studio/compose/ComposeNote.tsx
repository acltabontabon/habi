/**
 * What goes with a composed skill, and what doesn't. Other skills are named, not
 * included, so whoever installs or shares this should know. Only says what was
 * checked: nothing here installs them.
 */
import { useQuery } from "@tanstack/react-query";
import type { LocalSkill } from "../../../../bindings/LocalSkill";
import { api } from "../../../../lib/api";
import { clientName } from "./clients";
import { titleOfName } from "./knots";

export function ComposeNote({
  skill,
  projectId = null,
  mode,
}: {
  skill: LocalSkill;
  projectId?: string | null;
  mode: "install" | "share";
}) {
  const id = skill.summary.id;
  const composition = useQuery({
    queryKey: ["skill-composition", id, skill.documentDigest, skill.metadataDigest, projectId],
    queryFn: () => api.skillComposition(id, projectId),
    enabled: skill.composes.length > 0,
  });
  if (skill.composes.length === 0) return null;
  const deps = composition.data?.dependencies ?? [];
  const count = skill.composes.length;
  const libraries = [
    ...new Set(skill.composes.map((e) => e.from?.library).filter((l): l is string => Boolean(l))),
  ];
  return (
    <div className="field compose-note">
      <p className="field-label">
        {count === 1 ? "It names another skill" : `It names ${count} other skills`}
      </p>
      <p className="field-hint">
        {mode === "install"
          ? "They aren't brought with it. The instructions still make sense without them, but an agent can only use what it can find."
          : "They aren't included. The instructions name them in words, so anyone can see what's expected."}
      </p>
      <ul>
        {(deps.length
          ? deps
          : skill.composes.map((e) => ({ name: e.skill, availability: [], status: null }))
        ).map((d) => {
          const found = d.availability.filter((a) => a.state === "found").map((a) => clientName(a.client));
          const missing = d.availability
            .filter((a) => a.state === "notFound")
            .map((a) => clientName(a.client));
          return (
            <li key={d.name}>
              <span className="compose-note-name">{titleOfName(d.name)}</span>
              {mode === "install" && d.availability.length ? (
                <span className={`compose-note-where${missing.length ? " is-short" : ""}`}>
                  {missing.length === 0
                    ? "found"
                    : found.length === 0
                      ? "not found"
                      : `found for ${found.join(", ")}; not for ${missing.join(", ")}`}
                </span>
              ) : d.status === "missing" ? (
                <span className="compose-note-where is-short">not found here</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {mode === "share" && libraries.length ? (
        <p className="field-hint">
          Sharing this also shares where {count === 1 ? "it" : "they"} came from:{" "}
          <span className="mono">{libraries.join(", ")}</span>. Check that's fine for whoever receives it.
        </p>
      ) : null}
    </div>
  );
}
