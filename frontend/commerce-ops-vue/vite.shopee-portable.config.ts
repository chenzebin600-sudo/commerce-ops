import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  base: "/vue-preview/",
  resolve: {
    alias: [
      {
        find: /^@\/data\/shopee-shops$/,
        replacement: fileURLToPath(new URL("./src/data/shopee-shops.shared.ts", import.meta.url)),
      },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  build: {
    outDir: "../../public/shopee-api-portable",
    emptyOutDir: true,
    sourcemap: false,
  },
});
