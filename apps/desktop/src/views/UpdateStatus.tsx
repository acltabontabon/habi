/**
 * Where Habi stands with its own updates: the one place to check, install and restart, shown on the
 * About page and in Settings. The download's progress is the real byte count, not an animation.
 */
import { Button, Status } from "../components/ui";
import { sizeLabel } from "../lib/format";
import { releaseDate } from "../lib/release";
import { type UpdateState, useUpdates } from "../lib/updates";

/** What a screen reader hears as the phase changes: once per step, never per downloaded chunk. */
function announcement(state: UpdateState): string {
  switch (state.phase) {
    case "checking":
      return "Checking for updates…";
    case "current":
      return "Habi is up to date.";
    case "available":
      return `${state.info.version} is available.`;
    case "installing":
      return `Downloading ${state.info.version}…`;
    case "ready":
      return `${state.info.version} is installed.`;
    default:
      // Errors speak for themselves (an alert).
      return "";
  }
}

export function UpdateStatus() {
  const { state } = useUpdates();
  return (
    <>
      <UpdateLine state={state} />
      {/* One live region that stays put while the line below it changes. */}
      <span className="visually-hidden" role="status">
        {announcement(state)}
      </span>
    </>
  );
}

function UpdateLine({ state }: { state: UpdateState }) {
  const { check, install, restart } = useUpdates();

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
        <div className="update-line">
          <span className="muted">Checking for updates…</span>
        </div>
      );
    case "current":
      return (
        <div className="update-line">
          <Status tone="ok">Up to date</Status>
          <Button variant="quiet" size="sm" onClick={() => void check()}>
            Check again
          </Button>
        </div>
      );
    case "available":
      return (
        <div className="update-line is-offer">
          <div>
            <strong>{state.info.version} is available</strong>
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
        <div className="update-line is-installing">
          <span>
            Downloading {state.info.version}
            <span className="muted">
              {" · "}
              {total ? `${sizeLabel(downloaded)} of ${sizeLabel(total)}` : sizeLabel(downloaded)}
            </span>
          </span>
          {/* A thread drawn through as the bytes arrive; without a total it only shows life. */}
          <span
            className={`update-thread${fraction === null ? " is-unknown" : ""}`}
            style={fraction === null ? undefined : { ["--done" as string]: `${fraction * 100}%` }}
            role="progressbar"
            aria-label={`Downloading ${state.info.version}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
          />
        </div>
      );
    }
    case "ready":
      return (
        <div className="update-line is-offer">
          <div>
            <strong>{state.info.version} is installed</strong>
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
          <Button
            size="sm"
            onClick={() => void (state.installed ? restart() : state.info ? install() : check())}
          >
            Try again
          </Button>
        </div>
      );
  }
}
