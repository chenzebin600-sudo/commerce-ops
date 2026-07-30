import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/assets/growth-radar-v2/" : "/",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3101",
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4175,
    strictPort: false,
  },
  build: {
    outDir: "../../public/assets/growth-radar-v2",
    assetsDir: "assets",
    emptyOutDir: true,
    manifest: true,
    sourcemap: true,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        standalone: fileURLToPath(new URL("./index.html", import.meta.url)),
        embed: fileURLToPath(new URL("./src/embed.tsx", import.meta.url)),
      },
    },
  },
}));
