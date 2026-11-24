import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorNotice, errorLine, guidance, SELF_EXPLAINING } from "../components/ui";
import { HabiError } from "../lib/api";

/** Every code `HabiError::code` returns in `crates/habi-core/src/error.rs`. */
const CODES = [
  "invalidInput",
  "notFound",
  "pathEscape",
  "stalePlan",
  "conflict",
  "busy",
  "cancelled",
  "gitNetwork",
  "gitAuthentication",
  "gitNotFound",
  "gitMissing",
  "gitRejected",
  "git",
  "permissionDenied",
  "diskFull",
  "io",
  "database",
  "unsupported",
  "internal",
];

describe("errors", () => {
  it("say what to do next for every code whose message does not", () => {
    for (const code of CODES) {
      expect(Boolean(guidance[code]) || SELF_EXPLAINING.includes(code), code).toBe(true);
    }
    // Nothing is explained twice, and nothing is explained that the core never sends.
    for (const code of Object.keys(guidance)) {
      expect(CODES, code).toContain(code);
      expect(SELF_EXPLAINING, code).not.toContain(code);
    }
  });

  it("name what failed, what went wrong and the way out", () => {
    const error = new HabiError({ code: "gitNetwork", message: "could not reach github.com" });
    render(<ErrorNotice title="The library could not be fetched" error={error} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The library could not be fetched");
    expect(screen.getByText("could not reach github.com")).toBeInTheDocument();
    expect(screen.getByText(/Check your network or VPN/)).toBeInTheDocument();
    expect(errorLine("The skill could not be created", new Error("disk full"))).toBe(
      "The skill could not be created: disk full",
    );
    expect(errorLine("Not saved", error)).toMatch(
      /^Not saved: could not reach github\.com Check your network/,
    );
  });
});
