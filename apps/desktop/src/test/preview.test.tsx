/** Exercise the actual preview bridge, rather than a separate mock contract. */

import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { installPreview } from "../dev/preview";

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeAll(() =>
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: vi.fn(), configurable: true }),
);
afterAll(() => {
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  installPreview();
});
afterEach(() => {
  cleanup();
  clearMocks();
});

it("opens project install review with the shipped fixture contract", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Get started" }));
  await user.click((await screen.findAllByRole("button", { name: "billing-service" }))[0] as HTMLElement);
  await user.click(await screen.findByRole("button", { name: "Review and install…" }));
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText(/files will change/)).toBeInTheDocument();
  expect(within(dialog).getByRole("checkbox", { name: "Codex" })).toBeInTheDocument();
  expect(screen.queryByText("Habi could not show this screen")).not.toBeInTheDocument();
});

it("opens machine history and previews restore through the real preview bridge", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Get started" }));
  await user.click(await screen.findByRole("button", { name: "My skills" }));
  await user.click(await screen.findByRole("button", { name: "History and restore…" }));
  expect(await screen.findByRole("heading", { name: "History on this machine" })).toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "Restore…" }));
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText(/files will change/)).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: /Restore files changed by/ })).toBeInTheDocument();
});
