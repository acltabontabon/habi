import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/authoring.css";
import "./styles/studio.css";
import "./styles/weave.css";
import "./styles/welcome.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initTheme } from "./lib/theme";
import { installErrorLogging } from "./lib/uiErrors";

initTheme();
installErrorLogging();

async function start() {
  // Development only: in a plain browser, answer IPC from the development
  // bridge (the real core) when asked to, otherwise from core-generated fixtures.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    if (import.meta.env.VITE_HABI_BRIDGE) {
      const { installBridge } = await import("./dev/bridge");
      installBridge();
    } else {
      const { installPreview } = await import("./dev/preview");
      installPreview();
    }
  }
  const root = document.getElementById("root");
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <ErrorBoundary area="the app">
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  }
}

void start();
