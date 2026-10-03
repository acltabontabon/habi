/**
 * Where Habi stands with its own updates: the one place to check, install and restart, shown on the
 * About page and in Settings. The download's progress is the real byte count, not an animation.
 */
import { Button, Status } from "../components/ui";
import { sizeLabel } from "../lib/format";
import { releaseDate } from "../lib/release";
import { useUpdates } from "../lib/updates";

export function UpdateStatus() {
  const { state, check, install, restart } = useUpdates();

  switch (state.phase) {
    case "idle":
      return (
        <div className="update-line">
          <Button size="sm" onClick={() => void check()}>
            Check for updates
          </Button>
        </div>
      );
    case "checking":
      return (
        <div className="update-line" role="status" aria-live="polite">
          <span className="muted">Checking for updates…</span>
        </div>
      );
    case "current":
      return (
        <div className="update-line">
          <Status tone="ok">Habi is up to date</Status>
          <Button variant="quiet" size="sm" onClick={() => void check()}>
            Check again
          </Button>
        </div>
      );
    case "available":
      return (
        <div className="update-line is-offer">
          <div>
            <strong>Habi {state.info.version} is available</strong>
            {state.info.date ? (
              <span className="muted"> · {releaseDate(state.info.date.slice(0, 10))}</span>
            ) : null}
          </div>
          <Button variant="primary" size="sm" onClick={() => void install()}>
            Update and restart
          </Button>
        </div>
      );
    case "installing": {
      const { downloaded, total } = state;
      const fraction = total ? Math.min(1, downloaded / total) : null;
      return (
        <div className="update-line is-installing" role="status" aria-live="polite">
          <span>
            Downloading Habi {state.info.version}
            <span className="muted">
              {" · "}
              {total ? `${sizeLabel(downloaded)} of ${sizeLabel(total)}` : sizeLabel(downloaded)}
            </span>
          </span>
          {/* A thread drawn through as the bytes arrive; without a total it only shows life. */}
          <span
            className={`update-thread${fraction === null ? " is-unknown" : ""}`}
            style={fraction === null ? undefined : { ["--done" as string]: `${fraction * 100}%` }}
            aria-hidden="true"
          />
        </div>
      );
    }
    case "ready":
      return (
        <div className="update-line is-offer">
          <div>
            <strong>Habi {state.info.version} is installed</strong>
            <span className="muted">
              {state.unsaved
                ? " · Some edits are not saved yet. Save or discard them, then restart."
                : " · Restart to start using it."}
            </span>
          </div>
          <Button variant="primary" size="sm" onClick={() => void restart()}>
            Restart now
          </Button>
        </div>
      );
    case "error":
      return (
        <div className="update-line is-error" role="alert">
          <span>{state.message}</span>
          <Button size="sm" onClick={() => void (state.info ? install() : check())}>
            Try again
          </Button>
        </div>
      );
  }
}
