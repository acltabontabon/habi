import { describe, expect, it } from "vitest";
import type { ShareForm } from "../bindings/ShareForm";
import { ruleSentence, statementsFromCondition, statementsFromForm } from "./applicability";

const form: ShareForm = {
  title: "Build",
  owner: "",
  repositoryScope: false,
  conditionsEditable: true,
  matchMode: "any",
  appliesTags: ["lang:java", "framework:spring-boot"],
  appliesDependencies: ["org.liquibase:liquibase-core"],
  appliesFiles: [],
  excludeTags: ["build:gradle"],
  excludeDependencies: [],
  tools: [
    { name: "Maven", commands: ["mvn", "./mvnw"] },
    { name: "", commands: [] },
  ],
  examples: [],
};

describe("statementsFromForm", () => {
  it("words each condition, exception and tool", () => {
    const s = statementsFromForm(form);
    expect(s.mode).toBe("any");
    expect(s.applies.map((a) => a.phrase)).toEqual([
      { text: "it contains Java code" },
      { text: "it uses Spring Boot" },
      { text: "it depends on", code: "org.liquibase:liquibase-core" },
    ]);
    expect(s.excludes[0]?.phrase.text).toBe("it is tagged build:gradle");
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0]?.phrase).toEqual({
      text: "Maven —",
      code: "mvn or ./mvnw",
      after: "on PATH or in the project",
    });
    expect(s.scope).toBe("module");
    expect(s.empty).toBe(false);
  });

  it("reads as one sentence", () => {
    expect(ruleSentence(statementsFromForm(form))).toBe(
      "Suggested when it contains Java code, it uses Spring Boot or it depends on org.liquibase:liquibase-core, unless it is tagged build:gradle.",
    );
  });

  it("says plainly that a skill without rules is for manual use", () => {
    const none = statementsFromForm({ ...form, appliesTags: [], appliesDependencies: [] });
    expect(none.empty).toBe(true);
    expect(ruleSentence(none)).toMatch(/always available to use by hand/);
  });
});

describe("statementsFromCondition", () => {
  it("keeps nesting the builder cannot show", () => {
    const tree = statementsFromCondition({
      op: "all",
      items: [
        { op: "any", items: [{ op: "tag", tag: "lang:java" }, { op: "file", glob: "**/pom.xml" }] },
        { op: "not", item: { op: "dependency", name: "lombok", ecosystem: "maven", version: null } },
      ],
    });
    expect(tree).toEqual({
      op: "all",
      label: "all of these",
      items: [
        {
          op: "any",
          label: "any of these",
          items: [
            { op: "leaf", phrase: { text: "it contains Java code" } },
            { op: "leaf", phrase: { text: "it has files matching", code: "**/pom.xml" } },
          ],
        },
        {
          op: "not",
          label: "not when",
          item: { op: "leaf", phrase: { text: "it depends on", code: "lombok", after: "(maven)" } },
        },
      ],
    });
  });
});
