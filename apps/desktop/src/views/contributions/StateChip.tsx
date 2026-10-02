/**
 * A contribution's one state, as a chip (icon and word, never color alone),
 * with how fresh a host-reported state is.
 */
import type { Contribution } from "../../bindings/Contribution";
import { Status } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { sharingChip } from "../../lib/sharing";

export function StateChip({ contribution }: { contribution: Contribution }) {
  const chip = sharingChip(contribution);
  return (
    <span className="state">
      <span className="state-chip">
        <Status tone={chip.tone}>{chip.label}</Status>
      </span>
      {chip.checkedAt ? <span className="state-checked">checked {relativeTime(chip.checkedAt)}</span> : null}
    </span>
  );
}
