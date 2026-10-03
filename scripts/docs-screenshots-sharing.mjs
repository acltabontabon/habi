#!/usr/bin/env node
// The screenshots of docs/guide/sharing.md, taken from the running app with headless Chrome.
//
// Sharing needs a Git library that a pull request can be opened against, so unlike
// docs-screenshots.mjs this one touches a real GitHub repository: it connects it, writes a skill,
// shares it (a branch is pushed and a pull request opened), has a reviewer's comments added with
// `gh`, checks the status, and sends a revision. Use a repository made for the purpose, such as a
// private copy of fixtures/libraries/example-team-library, and one `gh` is signed in to.
//
// Start the development bridge on an empty HABI_HOME, and the UI against it, then run this with
// the same HABI_HOME:
//
//   export HABI_HOME=$(mktemp -d)
//   HABI_USER_HOME=$(mktemp -d) cargo run -p habi-core --example dev_bridge
//   cd apps/desktop && VITE_HABI_BRIDGE=1 pnpm dev
//   HABI_SHARE_LIBRARY=git@github.com:you/team-skills.git node scripts/docs-screenshots-sharing.mjs [http://127.0.0.1:1420]
//
// The pull request is closed, and its branch deleted, when the run ends. To retake only the
// draft-state pictures (share-dialog, share-review, share-send) without pushing anything or opening
// a pull request, set HABI_SHARE_STOP=draft; the library is then only read, never written to.
// Captured like the other
// screenshots: 1440×900 at twice the resolution, light theme, motion reduced, the development
// setup tidied away.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./lib/cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] ?? "http://127.0.0.1:1420";
const library = process.env.HABI_SHARE_LIBRARY;
const repo = library?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
if (!repo) {
  console.error("Set HABI_SHARE_LIBRARY to the address of a GitHub repository to share a skill with.");
  process.exit(1);
}

const gh = (...args) => {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const { send, page, until, click, type, scrollTo, shot, close } = await openBrowser({
  out: join(root, "docs/media"),
});

const PURPOSE = "Reviews a pull request for correctness, risk and fit. Use when asked to review a change or a PR.";
const REASON =
  "We keep rewriting this checklist in every repository. It asks for findings by severity, so reviews read the same whoever writes them.";

const instructions = (risk) => `## Before you start

- Read the change as a whole first, and note what it says it is for.
- Read the tests that changed before the code that did.

## Check

1. **Correctness**: does it do what it says, including edge cases and failure paths?
2. **Risk**: ${risk}
3. **Fit**: does it follow the conventions already in this codebase?
4. **Tests**: is the behaviour that changed covered?

## Report

List findings by severity, each with the file and line and why it matters.
Say what you checked, what you found, and what you could not verify.
`;

/** Replaces the skill's instructions in the editor. */
async function writeInstructions(text) {
  await page(`document.querySelector(".cm-content").focus()`);
  await page(`document.execCommand("selectAll")`);
  await type(text);
}

/** Waits for a contribution page to have settled (nothing busy, no spinner). */
const settled = `document.querySelector(".contribution-head") && !document.querySelector(".contribution [aria-busy=true]")`;

/** The pull request this run opened, once there is one. */
let pull;

/** Leaves the repository as it was found: the pull request closed, its branch deleted. */
function cleanUp() {
  gh("pr", "close", pull, "--repo", repo, "--delete-branch", "--comment", "Closing: a run of the documentation screenshots.");
}

async function run() {
  await send("Page.navigate", { url });
  await until(`document.querySelectorAll(".welcome .ws-tool").length >= 3`, "the welcome");
  await click("Get started");

  // The team's library, connected from its address.
  await until(`[...document.querySelectorAll("button, a")].some((b) => b.textContent.includes("Connect a library"))`, "the start screen");
  await click("Connect a library");
  await until(`[...document.querySelectorAll("button")].some((b) => b.textContent.includes("Connect a Git repository"))`, "the libraries page");
  await click("Connect a Git repository");
  await until(`document.querySelector("[placeholder^='git@github.com']")`, "the address field");
  await page(`document.querySelector("[placeholder^='git@github.com']").focus()`);
  await type(library);
  await until(`document.body.textContent.includes(${JSON.stringify(repo)})`, "the address to be read");
  await page(`(() => { const f = document.querySelector("[placeholder^='git@github.com']"); f.blur(); f.scrollLeft = 0; })()`);
  await shot("share-connect.jpg");
  await click("Connect library");
  await until(`document.querySelector(".skill-title-row")`, "the library", 120000);

  // A skill to share: from a starter, given a purpose and instructions of its own.
  await click("My skills", ".sidebar-item");
  await until(`document.querySelector(".skills-idea")`, "the starter ideas");
  await page(`document.querySelector(".skills-idea").click()`);
  await until(`document.querySelector(".cm-editor")`, "the Skill Studio");
  await writeInstructions(instructions("data loss, security, concurrency, compatibility."));
  await page(`document.querySelector("[placeholder^='What it helps with']").focus()`);
  await type(PURPOSE);
  await until(`!document.body.textContent.includes("thing to finish")`, "the skill to be ready", 20000);

  // Share: choose the library, then see exactly what would leave this machine.
  await click("Share");
  await until(`document.querySelector("[role=dialog] select")`, "the share dialog");
  await shot("share-dialog.jpg");
  await click("Review what will be shared", "[role=dialog] button");
  await until(settled, "the review");
  await until(`document.querySelector(".contribution textarea")`, "the message field");
  await scrollTo(".contribution-head");
  await shot("share-review.jpg");

  // The prepare step: the reviewer's message beside what goes on the branch, and the route it takes.
  await page(`document.querySelector(".contribution textarea").focus()`);
  await type(REASON);
  await until(`document.body.textContent.includes("Saved")`, "the message to be saved");
  await page(`document.activeElement.blur()`);
  await scrollTo(".cthread-title", "Prepare branch");
  await shot("share-send.jpg");
  if (process.env.HABI_SHARE_STOP === "draft") return;

  // Prepare the branch, then confirm sending it.
  await click("Prepare branch");
  await until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Create pull request"))`, "the branch to be prepared", 60000);
  await scrollTo(".cthread-title", "Branch prepared");
  await shot("share-prepared.jpg");
  await click("Create pull request");
  await until(`document.querySelector("[role=dialog]")`, "the confirmation");
  await shot("share-confirm.jpg");
  await click("Create pull request", "[role=dialog] button");
  await until(`/opened the pull request: https:/.test(document.body.textContent)`, "the pull request to open", 120000);
  pull = await page(`document.body.textContent.match(/https:\\/\\/github\\.com\\/[^\\s]+\\/pull\\/(\\d+)/)[1]`);
  await page(`window.scrollTo(0, 0); document.querySelector("main, .page")?.scrollTo?.(0, 0)`);
  await shot("share-sent.jpg");

  // A reviewer replies on the host: one remark on a line, one general.
  const branchHead = gh("api", `repos/${repo}/pulls/${pull}`, "--jq", ".head.sha");
  const patch = gh("api", `repos/${repo}/pulls/${pull}/files`, "--jq", ".[0].patch").split("\n");
  const line = patch.findIndex((l) => l.includes("**Risk**"));
  gh(
    "api", "-X", "POST", `repos/${repo}/pulls/${pull}/comments`,
    "-f", "body=Could this say what counts as a risk here? Reviewers on other teams read the word differently.",
    "-f", `commit_id=${branchHead}`,
    "-f", `path=${gh("api", `repos/${repo}/pulls/${pull}/files`, "--jq", ".[0].filename")}`,
    "-F", `line=${line}`,
    "-f", "side=RIGHT",
  );
  gh("pr", "comment", pull, "--repo", repo, "--body", "Thanks, this is close. One note on the Risk line, and then I think it is ready for the guild to look at.");

  // Habi reads the request only when asked.
  await click("Check status");
  await until(`document.querySelector(".review-comments")`, "the review comments", 60000);
  await scrollTo(".review-card");
  await shot("share-review-status.jpg");

  // Revising: edit the skill where it lives, then revise, prepare and push the new version.
  await click("My skills", ".sidebar-item");
  await until(`[...document.querySelectorAll("a, button, li")].some((e) => e.textContent.includes("Review a pull request"))`, "the skill in My skills");
  await click("Review a pull request", "a, button");
  await until(`document.querySelector(".cm-editor")`, "the Skill Studio");
  await writeInstructions(
    instructions("what is the worst thing that could happen if this change is wrong? Data loss, security, concurrency, compatibility."),
  );
  await sleepSave();
  await click("Contributions", ".sidebar-item");
  await until(`document.querySelector(".share-list")`, "the contributions");
  await click("Share Review a pull request", "button, a");
  await until(settled, "the contribution");
  await click("Revise");
  await until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Prepare the revision"))`, "the revision", 60000);
  await click("Prepare the revision");
  await until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Push revision"))`, "the revision to be prepared", 60000);
  await scrollTo(".cthread-title", "Branch prepared");
  await shot("share-revision.jpg");
  await click("Push revision");
  await until(`document.querySelector("[role=dialog]")`, "the confirmation");
  await click("Push revision", "[role=dialog] button");
  await until(`/shows this revision/.test(document.body.textContent)`, "the revision to be pushed", 120000);
  await page(`document.querySelector("main, .page")?.scrollTo?.(0, 0); window.scrollTo(0, 0)`);
  await shot("share-revised.jpg");
}

/** The editor saves a moment after the last keystroke. */
async function sleepSave() {
  await new Promise((r) => setTimeout(r, 2500));
}

try {
  await run();
} finally {
  await close();
  if (pull) cleanUp();
}
