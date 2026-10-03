/**
 * Development-only bridge to the real core.
 *
 * With `VITE_HABI_BRIDGE=1 pnpm dev` and the bridge example running
 * (`cargo run -p habi-core --example dev_bridge`), IPC calls made in a plain
 * browser reach the actual Rust service: real inspection, drafts on disk,
 * Git and install plans. Native dialogs do not exist in a browser, so
 * commands that open a picker ask for a path in a small in-page prompt.
 * Never part of a build.
 */
import { mockIPC } from "@tauri-apps/api/mocks";

const PICKERS: Record<string, string> = {
  pick_project: "Project folder",
  pick_library_folder: "Library folder",
  pick_import_folder: "Folder to look for skills in",
  export_skill: "Zip file to save the skill as",
  export_contribution: "Folder to save the patch in",
  add_skill_files: "File to add to the skill",
  replace_skill_file: "File to replace it with",
};

function askPath(label: string): Promise<string | null> {
  return new Promise((resolve) => {
    // A plain fixed panel rather than <dialog>, so it also sits above the
    // app's own modal dialogs and shows in screenshots.
    const dialog = document.createElement("div");
    dialog.id = "bridge-path-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", label);
    dialog.style.cssText =
      "position:fixed;z-index:200;pointer-events:auto;left:50%;top:20%;transform:translateX(-50%);padding:16px;border:1px solid var(--hairline-strong);border-radius:8px;background:var(--paper);color:var(--ink);font:14px var(--font-ui);width:min(560px,90vw);box-shadow:var(--shadow-dialog)";
    const form = document.createElement("form");
    form.method = "dialog";
    const title = document.createElement("label");
    title.textContent = `${label} (development bridge: type an absolute path)`;
    title.htmlFor = "bridge-path";
    title.style.cssText = "display:block;margin-bottom:8px;font-weight:600";
    const input = document.createElement("input");
    input.id = "bridge-path";
    input.className = "input mono";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-quiet btn-md";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "btn btn-primary btn-md";
    ok.textContent = "Choose";
    row.append(cancel, ok);
    form.append(title, input, row);
    dialog.append(form);
    const finish = (value: string | null) => {
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") finish(null);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      finish(input.value.trim() || null);
    });
    document.body.append(dialog);
    input.focus();
  });
}

async function invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  if (cmd === "plugin:event|listen") return 1;
  if (cmd === "plugin:event|unlisten") return null;
  let payload = args;
  const picker = PICKERS[cmd];
  if (picker) {
    const path = await askPath(picker);
    if (path === null) return null;
    payload = { ...args, __path: path };
  }
  let response: Response;
  try {
    response = await fetch("/__habi/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-habi-bridge": "1" },
      body: JSON.stringify({ cmd, args: payload }),
    });
  } catch {
    throw { code: "internal", message: "The development bridge is not reachable." };
  }
  if (!response.ok) {
    throw { code: "internal", message: `The development bridge answered ${response.status}.` };
  }
  const reply = (await response.json()) as { ok?: unknown; err?: unknown };
  if (reply.err) throw reply.err;
  return reply.ok ?? null;
}

export function installBridge() {
  mockIPC((cmd, args) => invoke(cmd, (args ?? {}) as Record<string, unknown>));
  // The mode is named in the tab title, not on screen.
  document.title = "Habi — development bridge";
}
