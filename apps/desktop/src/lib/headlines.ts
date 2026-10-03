/**
 * The welcome's headline. One is chosen each time it opens: the brand line, or
 * a dry observation about the problem Habi is for. Each must be true of how
 * teams and agents really work, and none may carry a number or a claim that
 * needs a source: it is a wink, not a statistic. `em` is the phrase set in the
 * thread color and must appear in `text`.
 */
export type Headline = { text: string; em: string };

export const HEADLINES: Headline[] = [
  { text: "What one developer learns, every project keeps.", em: "every project" },
  { text: "Your best skill lives in one repo. One person knows.", em: "One person knows." },
  { text: "Every agent session starts knowing nothing about your team.", em: "knowing nothing" },
  { text: "Unwritten lessons are just postmortem stories.", em: "postmortem stories" },
  { text: "Copy a skill between repos and it forks quietly.", em: "forks quietly" },
  { text: "Every “we should document this” is a skill not yet written.", em: "a skill not yet written" },
  { text: "Somewhere, a teammate is rewriting your prompt.", em: "rewriting your prompt" },
  { text: "Habi has no opinion about your commit messages.", em: "no opinion" },
  { text: "Nothing changes until you review the plan.", em: "review the plan" },
];

/** A headline chosen at random; `pick` is injectable so a test can choose. */
export function pickHeadline(pick: () => number = Math.random): Headline {
  const fallback = HEADLINES[0] as Headline;
  return HEADLINES[Math.min(HEADLINES.length - 1, Math.floor(pick() * HEADLINES.length))] ?? fallback;
}

/** The text before, inside and after the highlighted phrase. */
export function headlineParts({ text, em }: Headline): [string, string, string] {
  const at = text.indexOf(em);
  return at < 0 ? [text, "", ""] : [text.slice(0, at), em, text.slice(at + em.length)];
}
