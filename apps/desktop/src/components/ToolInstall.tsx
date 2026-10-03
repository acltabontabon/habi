/**
 * How to get a missing command-line tool on this machine: one line to paste
 * when there is a dependable one, the tool's own instructions otherwise, and
 * what to run once it is installed.
 */

import { useOpenExternal } from "../lib/safeInvoke";
import { installCommand, type ToolFact } from "../lib/tools";
import { Icon } from "./Icon";
import { useToast } from "./Toasts";

export function ToolInstall({ tool, platform }: { tool: ToolFact; platform: string }) {
  const openExternal = useOpenExternal();
  const toast = useToast();
  const command = installCommand(tool.key, platform);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show("Copied.");
    } catch {
      toast.show("Could not copy. Select the command and copy it.", "danger");
    }
  };

  return (
    <div className="ws-fix">
      {command ? (
        <div className="ws-command">
          <code>{command}</code>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Copy ${command}`}
            onClick={() => void copy(command)}
          >
            <Icon name="file" size={14} />
          </button>
        </div>
      ) : null}
      <button type="button" className="link-quiet ws-link" onClick={() => openExternal(tool.url)}>
        {command ? "Other ways to install" : `Install ${tool.name}`}
        <Icon name="external" size={12} />
      </button>
      {tool.after ? (
        <p className="ws-after">
          Then sign in with <code>{tool.after}</code>.
        </p>
      ) : null}
    </div>
  );
}
