import { describe, expect, it } from "vitest";
import {
  describedIn,
  fileLede,
  firstHeading,
  materialKind,
  materialsLine,
  materialsOf,
  mentions,
  proposeSignals,
  technologiesIn,
} from "./materials";

const body = `# Web Application Testing

**Helper Scripts Available**:
- \`scripts/with_server.py\` - Manages server lifecycle (supports multiple servers)

Playwright scripts, Playwright selectors.

- **examples/** - Examples showing common patterns:
  - \`element_discovery.py\` - Discovering buttons, links, and inputs on a page
`;

const file = (path: string, executable = false) => ({ path, size: 1, digest: "d", executable, text: true });

describe("materials", () => {
  it("reads what a file is from where it sits and what it is", () => {
    expect(materialKind("scripts/with_server.py")).toBe("script");
    expect(materialKind("examples/console_logging.py")).toBe("example");
    expect(materialKind("references/api.md")).toBe("reference");
    expect(materialKind("assets/logo.png")).toBe("asset");
    expect(materialKind("LICENSE.txt")).toBe("other");
    expect(materialKind("guide.md")).toBe("reference");
    expect(materialKind("run", true)).toBe("script");
  });

  it("knows a file is referenced by its path or its unmistakable name", () => {
    const all = ["scripts/with_server.py", "examples/element_discovery.py", "examples/console_logging.py"];
    expect(mentions(body, "scripts/with_server.py", all)).toBe(true);
    expect(mentions(body, "examples/element_discovery.py", all)).toBe(true);
    expect(mentions(body, "examples/console_logging.py", all)).toBe(false);
  });

  it("takes what a file is for from the instructions, then from the file itself", () => {
    expect(describedIn(body, "scripts/with_server.py")).toBe(
      "Manages server lifecycle (supports multiple servers)",
    );
    expect(describedIn(body, "examples/element_discovery.py")).toBe(
      "Discovering buttons, links, and inputs on a page",
    );
    expect(fileLede("from x import y\n\n# Example: Capturing console logs during automation\n")).toBe(
      "Capturing console logs during automation",
    );
    expect(fileLede('#!/usr/bin/env python3\n"""Start the server, then run."""\n')).toBe(
      "Start the server, then run",
    );
  });

  it("says what comes with a skill in one line", () => {
    const m = materialsOf(
      [
        file("SKILL.md"),
        file("scripts/with_server.py"),
        file("examples/a.py"),
        file("examples/b.py"),
        file("examples/c.py"),
        file("LICENSE.txt"),
      ],
      body,
    );
    expect(materialsLine(m)).toBe("1 script · 3 examples · LICENSE.txt");
  });

  it("proposes signals from a few words, and finds what the instructions keep naming", () => {
    const p = proposeSignals("Playwright");
    expect(p[0]).toMatchObject({ kind: "tag", value: "test:playwright" });
    expect(p.some((s) => s.kind === "file" && s.value === "**/playwright.config.*")).toBe(true);
    expect(proposeSignals("@playwright/test")[0]).toMatchObject({ kind: "dependency" });
    expect(proposeSignals("**/db/changelog/**")).toEqual([
      { kind: "file", value: "**/db/changelog/**", why: "A file in the project" },
    ]);
    expect(technologiesIn(body)).toEqual(["test:playwright"]);
    expect(firstHeading(body)).toBe("Web Application Testing");
  });
});
