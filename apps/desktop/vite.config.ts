import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Tauri serves the built files; the dev server is only used during development.
// HABI_UI_PORT / HABI_BRIDGE_PORT let a second dev pair run alongside the default one.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const uiPort = Number(env.HABI_UI_PORT || 1420);
  const bridgePort = Number(env.HABI_BRIDGE_PORT || 1430);
  return {
    plugins: [react()],
    clearScreen: false,
    server: {
      port: uiPort,
      strictPort: true,
      host: "127.0.0.1",
      // Development bridge to the real core (see crates/habi-core/examples/dev_bridge.rs).
      proxy: {
        "/__habi": {
          target: `http://127.0.0.1:${bridgePort}`,
          rewrite: (path) => path.replace(/^\/__habi/, ""),
        },
      },
    },
    build: {
      target: "es2022",
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      css: false,
    },
  };
});
