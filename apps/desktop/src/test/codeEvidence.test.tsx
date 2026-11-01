/** A reason names the code behind it, and each place opens at its line. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { EvalNode } from "../bindings/EvalNode";
import type { ProjectOverview } from "../bindings/ProjectOverview";
import { ToastProvider } from "../components/Toasts";
import { api } from "../lib/api";
import { EvalTree } from "../views/project/Explain";

const overview = {
  project: { id: "p" },
  inspection: { facts: [] },
  declarations: [],
} as unknown as ProjectOverview;

const held: EvalNode = {
  condition: { op: "code", kind: "annotation", name: "Transactional", language: null },
  summary: "uses the annotation Transactional",
  outcome: "true",
  reason: "used in src/OrderService.java:17 and 1 more file",
  facts: [],
  declarations: [],
  files: [],
  location: "src/OrderService.java:17",
  code: [
    { file: "src/OrderService.java", line: 17, excerpt: "Transactional" },
    { file: "src/RefundService.java", line: 8, excerpt: "Transactional" },
  ],
  children: [],
};

function shown(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ul>{ui}</ul>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("lists each place in the code with the name found there", () => {
  shown(<EvalTree node={held} overview={overview} />);
  expect(screen.getByText(/used in src\/OrderService.java:17 and 1 more file/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "src/OrderService.java:17 — Transactional" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "src/RefundService.java:8 — Transactional" }),
  ).toBeInTheDocument();
});

it("opens a place at its line", async () => {
  const user = userEvent.setup();
  const read = vi.spyOn(api, "readProjectExcerpt").mockResolvedValue({
    path: "src/RefundService.java",
    lines: ["@Transactional"],
    startLine: 8,
    highlight: 8,
    totalLines: 12,
  } as never);
  shown(<EvalTree node={held} overview={overview} />);
  await user.click(screen.getByRole("button", { name: "src/RefundService.java:8 — Transactional" }));
  expect(read).toHaveBeenCalledWith("p", "src/RefundService.java", 8);
  expect(await screen.findByText("@Transactional")).toBeInTheDocument();
});

it("shows nothing extra when the code says nothing", () => {
  shown(<EvalTree node={{ ...held, code: [] }} overview={overview} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
