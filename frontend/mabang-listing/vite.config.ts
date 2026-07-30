import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/assets/mabang-listing/" : "/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4176,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3101",
        changeOrigin: false
      }
    }
  },
  build: {
    outDir: "../../public/assets/mabang-listing",
    assetsDir: "assets",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        standalone: fileURLToPath(new URL("./index.html", import.meta.url)),
        embed: fileURLToPath(new URL("./src/embed.tsx", import.meta.url))
      }
    }
  }
}));
