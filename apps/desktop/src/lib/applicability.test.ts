import { describe, expect, it } from "vitest";
import { statementsFromCondition, toolPhrase } from "./applicability";

describe("toolPhrase", () => {
  it("names the tool and the commands that count", () => {
    expect(toolPhrase({ name: "Maven", commands: ["mvn", "./mvnw"] })).toEqual({
      text: "Maven —",
      code: "mvn or ./mvnw",
      after: "on PATH or in the project",
    });
  });
});

describe("statementsFromCondition", () => {
  it("keeps nesting the builder cannot show", () => {
    const tree = statementsFromCondition({
      op: "all",
      items: [
        {
          op: "any",
          items: [
            { op: "tag", tag: "lang:java" },
            { op: "file", glob: "**/pom.xml" },
          ],
        },
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
