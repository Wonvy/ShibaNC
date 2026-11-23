import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8")
) as { version?: string };

export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version || "0.1.0"),
    __GITHUB_REPO__: JSON.stringify(process.env.VITE_GITHUB_REPO || ""),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: false,
    host: host || "127.0.0.1",
    fs: {
      allow: [".."],
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
