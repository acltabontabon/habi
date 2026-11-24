import { useState } from "react";
import { Button } from "../../components/ui";
import { useSources } from "../../lib/queries";
import { ReviewDialog } from "./ReviewDialog";

/**
 * Installs a tool its library ships, on this machine, after the same review
 * as anything else. A tool is for the person, so no agent is chosen.
 */
export function InstallTool({
  sourceId,
  toolId,
  name,
  primary = false,
}: {
  sourceId: string;
  toolId: string;
  /** The command, as the person types it. */
  name: string;
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sources = useSources();
  const source = sources.data?.find((s) => s.id === sourceId);
  return (
    <>
      <Button variant={primary ? "primary" : "quiet"} icon="download" onClick={() => setOpen(true)}>
        {primary ? "Install on this machine…" : `Install ${name} from this library…`}
      </Button>
      {open ? (
        <ReviewDialog
          projectId={null}
          request={{
            kind: "install",
            items: [{ sourceId, itemId: toolId }],
            title: name,
            tool: true,
            // Only the team's own library is reviewed by the team; anything else needs a tick.
            unaudited: source?.role !== "team",
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
