/**
 * Checking a save means reading the whole file back, which on a long skill takes
 * long enough to feel in the caret. So long documents are checked off the main thread.
 */
import { type Verdict, verifyText } from "./verify";

type Pending = { resolve: (v: Verdict) => void; output: string; canon: string };

let worker: Worker | null | undefined;
let next = 1;
const waiting = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker =
      typeof Worker === "undefined"
        ? null
        : new Worker(new URL("./verify.worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (e: MessageEvent<{ id: number; verdict: Verdict }>) => {
      waiting.get(e.data.id)?.resolve(e.data.verdict);
      waiting.delete(e.data.id);
    };
    worker.onerror = () => {
      // Losing the worker never skips the check: it happens here instead.
      worker = null;
      for (const p of waiting.values()) p.resolve(verifyText(p.output, p.canon));
      waiting.clear();
    };
  }
  return worker;
}

/** Below this, reading it back takes less time than handing it over. */
const WORKER_ABOVE = 16 * 1024;

export function verifyInBackground(output: string, canon: string): Promise<Verdict> {
  const target = output.length > WORKER_ABOVE ? ensureWorker() : null;
  if (!target) return Promise.resolve(verifyText(output, canon));
  return new Promise((resolve) => {
    const id = next++;
    waiting.set(id, { resolve, output, canon });
    target.postMessage({ id, output, canon });
  });
}
