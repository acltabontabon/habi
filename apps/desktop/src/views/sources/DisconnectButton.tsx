/**
 * Disconnect a library, from the library's own header. Habi forgets the
 * library and removes its cached copy; nothing that was already added to a
 * project, or copied into My skills, is touched. It can be connected again at
 * any time.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Source } from "../../bindings/Source";
import { Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toasts";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { useNav } from "../../lib/nav";
import { invalidateProjectData } from "../../lib/queries";

export function DisconnectButton({ source }: { source: Source }) {
  const client = useQueryClient();
  const toast = useToast();
  const { navigate } = useNav();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.removeSource(source.id);
    } catch (e) {
      toast.show(
        `Could not disconnect ${source.name}: ${e instanceof Error ? e.message : String(e)}`,
        "danger",
      );
      setBusy(false);
      return;
    }
    invalidateProjectData(client);
    toast.show(`${source.name} disconnected. Nothing in your projects or My skills was changed.`);
    setOpen(false);
    // The library you were in is gone: Back should not return to it.
    navigate({ name: "sources" }, { replace: true });
  };

  return (
    <>
      <Button variant="quiet" size="sm" icon="trash" onClick={() => setOpen(true)}>
        Disconnect
      </Button>
      {open ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next && !busy) setOpen(false);
          }}
          title={`Disconnect ${source.name}?`}
          description="Habi forgets this library and removes its cached copy."
          footer={
            <>
              <Button variant="quiet" onClick={() => setOpen(false)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="danger" busy={busy} onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </>
          }
        >
          <p className="muted">
            Skills already in your projects, and copies in My skills, stay exactly as they are; they just
            can't check this library for updates until you connect it again, which you can do any time.
          </p>
        </Dialog>
      ) : null}
    </>
  );
}
