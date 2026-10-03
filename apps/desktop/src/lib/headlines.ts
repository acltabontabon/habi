/**
 * The welcome's headline, and the line beneath it. One is chosen each time it
 * opens: the brand line, or a dry observation about the problem Habi is for.
 * Each must be true of how teams and agents really work, and none may carry a
 * number or a claim that needs a source: it is a wink, not a statistic. `em`
 * is the phrase set in the thread color and must appear in `text`. `sub`
 * answers the headline with what Habi does about it, plainly.
 */
export type Headline = { text: string; em: string; sub: string };

export const HEADLINES: Headline[] = [
  {
    text: "What one developer learns, every project keeps.",
    em: "every project",
    sub: "Skills your team has written, matched to your project.",
  },
  {
    text: "Your best skill lives in one repo. One person knows.",
    em: "One person knows.",
    sub: "Habi finds it, and every other project it fits.",
  },
  {
    text: "Every agent session starts knowing nothing about your team.",
    em: "knowing nothing",
    sub: "Give it the skills that fit, right where it looks.",
  },
  {
    text: "Unwritten lessons are just postmortem stories.",
    em: "postmortem stories",
    sub: "Write it once as a skill; every project it fits gets it.",
  },
  {
    text: "Copy a skill between repos and it forks quietly.",
    em: "forks quietly",
    sub: "Installed through Habi, it remembers where it came from.",
  },
  {
    text: "Every “we should document this” is a skill not yet written.",
    em: "a skill not yet written",
    sub: "Write it in Markdown; Habi finds where it fits.",
  },
  {
    text: "Somewhere, a teammate is rewriting your prompt.",
    em: "rewriting your prompt",
    sub: "Share yours instead, as a pull request they can review.",
  },
  {
    text: "Habi has no opinion about your commit messages.",
    em: "no opinion",
    sub: "It does know which skills fit, down to the file and line.",
  },
  {
    text: "Nothing changes until you review the plan.",
    em: "review the plan",
    sub: "Every file is shown first; every change can be restored.",
  },
  {
    text: "Your agent read the README. Nobody else has.",
    em: "Nobody else has.",
    sub: "Habi reads the build files too, and matches what’s real.",
  },
  {
    text: "The fix is in a Slack thread nobody can find.",
    em: "nobody can find",
    sub: "Put it in a skill, and Habi brings it where it fits.",
  },
  {
    text: "Tribal knowledge has a bus factor of one.",
    em: "a bus factor of one",
    sub: "Turn it into skills the whole team can find and install.",
  },
  {
    text: "Your agent will confidently repeat last quarter’s mistake.",
    em: "confidently repeat",
    sub: "Unless a skill says otherwise. Habi finds that skill.",
  },
  {
    text: "The senior engineer is the documentation. They’re on leave.",
    em: "They’re on leave.",
    sub: "Turn their checklist into a skill every project gets.",
  },
  {
    text: "Every repo has a CLAUDE.md nobody remembers writing.",
    em: "nobody remembers writing",
    sub: "Habi shows what’s already there before it adds a thing.",
  },
  {
    text: "Prompts copied from a gist age like milk.",
    em: "age like milk",
    sub: "Habi-installed skills know when a newer version exists.",
  },
  {
    text: "Your agent doesn’t know you migrated off that library.",
    em: "migrated off",
    sub: "Habi reads your build files, so stale skills step aside.",
  },
  {
    text: "Code review caught it again. And again.",
    em: "And again.",
    sub: "Write the check down once; every project it fits gets it.",
  },
  {
    text: "Good skills die in someone’s home folder.",
    em: "someone’s home folder",
    sub: "Habi finds them on this machine and helps you share them.",
  },
  {
    text: "AGENTS.md is a wish list until someone maintains it.",
    em: "until someone maintains it",
    sub: "Team instructions arrive as sections that stay updated.",
  },
  {
    text: "The agent forgot. It always forgets. Write it down.",
    em: "Write it down.",
    sub: "A skill is a page of Markdown, where every agent looks.",
  },
  {
    text: "Onboarding docs: written once, trusted forever, true briefly.",
    em: "true briefly",
    sub: "Skills get updates, and your own edits survive them.",
  },
  {
    text: "Your context window is not a knowledge base.",
    em: "not a knowledge base",
    sub: "Your team libraries are. Habi brings them to your project.",
  },
  {
    text: "That clever prompt in your notes app helps exactly one person.",
    em: "exactly one person",
    sub: "Make it a skill and send it to the team for review.",
  },
  {
    text: "Every team reinvents the same review checklist.",
    em: "the same review checklist",
    sub: "Habi finds the one someone already wrote.",
  },
  {
    text: "The postmortem said “document this.” Nobody did.",
    em: "Nobody did.",
    sub: "Write it as a skill this time. Habi takes it from there.",
  },
  {
    text: "Skills without a home become folklore.",
    em: "folklore",
    sub: "Team libraries are their home: in Git, reviewed, shared.",
  },
  {
    text: "No account. No telemetry. No cloud. No kidding.",
    em: "No kidding.",
    sub: "Habi runs on this machine, with the Git you already have.",
  },
  {
    text: "Habi never runs a skill’s scripts. It reads them.",
    em: "It reads them.",
    sub: "And tells you what each one needs before you install.",
  },
  {
    text: "Copy-paste is not a distribution strategy.",
    em: "not a distribution strategy",
    sub: "Team libraries are. Connect one, and Habi does the rest.",
  },
  {
    text: "Works on your machine. Now it can work on theirs.",
    em: "work on theirs",
    sub: "Share what you refined as a reviewed pull request.",
  },
  {
    text: "Your agent has read more Stack Overflow than your whole team.",
    em: "than your whole team",
    sub: "It hasn’t read your conventions. Habi can fix that.",
  },
  {
    text: "Every repo is a snowflake. Your skills shouldn’t care.",
    em: "shouldn’t care",
    sub: "Habi matches each stack, module by module.",
  },
  {
    text: "A skill nobody reviewed is just a rumor.",
    em: "just a rumor",
    sub: "Community skills are labeled. Team skills get reviewed.",
  },
  {
    text: "“It works for me” is not a review process.",
    em: "not a review process",
    sub: "Send your skill to the team library as a pull request.",
  },
  {
    text: "Your agent will happily run curl | bash. Habi flags it.",
    em: "Habi flags it.",
    sub: "Skills that download code or touch secrets are marked.",
  },
  {
    text: "Undo is a feature, not a prayer.",
    em: "not a prayer",
    sub: "Every change Habi makes is journaled and can be restored.",
  },
  {
    text: "Seven agent tools, one SKILL.md.",
    em: "one SKILL.md",
    sub: "Habi writes it once, where every one of them looks.",
  },
  {
    text: "Unknown is a valid answer.",
    em: "valid answer",
    sub: "When Habi can’t tell if a skill fits, it asks.",
  },
  {
    text: "The best prompt engineer on your team is a Markdown file.",
    em: "a Markdown file",
    sub: "Habi gets it to every project and agent that needs it.",
  },
  {
    text: "Merge conflicts, but for prompts.",
    em: "for prompts",
    sub: "Updates merge three ways, and Habi explains what’s left.",
  },
  {
    text: "Your team’s knowledge, minus the meeting.",
    em: "minus the meeting",
    sub: "Written down once, found by every project that needs it.",
  },
  {
    text: "Trust, but read the diff.",
    em: "read the diff",
    sub: "Habi shows every file before anything is written.",
  },
  {
    text: "Your agent can’t attend the architecture review.",
    em: "can’t attend",
    sub: "Write the decisions into a skill; Habi delivers it.",
  },
  {
    text: "Your linter has rules. Your agent has vibes.",
    em: "has vibes",
    sub: "Give it rules: your team’s skills, matched to the project.",
  },
  {
    text: "Your agent doesn’t read the wiki. Nobody does.",
    em: "Nobody does.",
    sub: "Put it in a skill, where the agent actually looks.",
  },
  {
    text: "The new hire’s agent knows less than the new hire.",
    em: "less than the new hire",
    sub: "Install the team’s skills on day one.",
  },
  {
    text: "Your prompts deserve version control too.",
    em: "version control",
    sub: "Skills live in Git, with history, review and updates.",
  },
  {
    text: "Hand-copied skills never get the fix.",
    em: "never get the fix",
    sub: "Habi-installed skills hear when the library changes.",
  },
  {
    text: "You fixed it in one repo. The other repos didn’t hear.",
    em: "didn’t hear",
    sub: "Send the fix to the library; every project can update.",
  },
  {
    text: "Context is the new legacy code.",
    em: "legacy code",
    sub: "Keep it in skills: reviewed, versioned and matched.",
  },
  {
    text: "“Just ask the team” is not documentation.",
    em: "not documentation",
    sub: "Write it as a skill, and the agent can ask it instead.",
  },
  {
    text: "Your agent is only as good as the last thing it read.",
    em: "the last thing it read",
    sub: "Make it your team’s skills, matched to the project.",
  },
  {
    text: "AGENTS.md, CLAUDE.md, GEMINI.md. Same idea, three files.",
    em: "three files",
    sub: "Habi writes it once and imports it where each tool looks.",
  },
  {
    text: "Habi reads your pom.xml so your agent doesn’t have to guess.",
    em: "doesn’t have to guess",
    sub: "Build files and lockfiles tell it what fits.",
  },
  {
    text: "Works offline, because the train has no Wi-Fi.",
    em: "the train has no Wi-Fi",
    sub: "Libraries live on this machine; finding needs no network.",
  },
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
