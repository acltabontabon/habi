/**
 * What Habi noticed while reading a skill's files, as a short list. These are
 * signals from a static reading, not a verdict: the wording says what was
 * found and where, never that something is safe.
 */
import type { LibraryItem } from "../../bindings/LibraryItem";
import type { Signal } from "../../bindings/Signal";
import { Icon } from "../../components/Icon";
import { severityWord, signalFile } from "../../lib/catalog";

export const SIGNALS_METHOD = "Found by reading the files as text; nothing was run.";
export const SIGNALS_LIMIT =
  "A static reading misses things and flags harmless ones, so read a skill before you adopt it.";
export const SIGNALS_CAVEAT = `${SIGNALS_METHOD} ${SIGNALS_LIMIT}`;

export function SignalList({
  item,
  onOpenFile,
}: {
  item: LibraryItem;
  /** Opens a file of the skill (a path relative to the skill's folder). */
  onOpenFile?: (path: string) => void;
}) {
  if (item.signals.length === 0) {
    return <p className="muted">Nothing stood out. That is not a guarantee. {SIGNALS_LIMIT}</p>;
  }
  return (
    <div className="signals">
      <ul className="signal-list">
        {item.signals.map((s: Signal, i) => {
          const file = signalFile(item, s);
          const where = s.path ? `${s.path}${s.line ? `:${s.line}` : ""}` : null;
          return (
            // The list is rebuilt whole when a library changes, so the index is a stable key.
            <li key={`${s.kind}-${s.path}-${s.line ?? 0}-${i}`} className={`signal is-${s.severity}`}>
              <span className="signal-mark" title={severityWord[s.severity]}>
                <Icon name={s.severity === "caution" ? "warning" : "dot"} size={12} />
                <span className="visually-hidden">{severityWord[s.severity]}: </span>
              </span>
              <span className="signal-what">
                {s.summary}
                {s.more > 0 ? <span className="muted"> · {s.more} more here</span> : null}
              </span>
              {where ? (
                file && onOpenFile ? (
                  <button type="button" className="signal-where mono" onClick={() => onOpenFile(file)}>
                    {where}
                  </button>
                ) : (
                  <span className="signal-where mono">{where}</span>
                )
              ) : null}
              {s.detail ? <code className="signal-detail">{s.detail}</code> : null}
            </li>
          );
        })}
      </ul>
      <p className="signals-caveat muted">{SIGNALS_CAVEAT}</p>
    </div>
  );
}
