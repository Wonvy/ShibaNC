import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
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
