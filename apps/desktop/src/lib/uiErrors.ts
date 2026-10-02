/**
 * Errors the UI did not handle go to Habi's log, so a saved diagnostic
 * report includes them. Logging never throws, and a render loop cannot
 * flood the log.
 */
import { api } from "./api";

const LIMIT = 50;
let sent = 0;

export function logUiError(error: unknown, context?: string) {
  if (sent >= LIMIT) return;
  sent += 1;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  const detail = [context, stack].filter(Boolean).join("\n");
  void api.logUiError(message, detail || null).catch(() => undefined);
}

/** Uncaught errors and unhandled promise rejections, from anywhere in the page. */
export function installErrorLogging() {
  window.addEventListener("error", (e) => logUiError(e.error ?? e.message, "uncaught error"));
  window.addEventListener("unhandledrejection", (e) => logUiError(e.reason, "unhandled rejection"));
}
