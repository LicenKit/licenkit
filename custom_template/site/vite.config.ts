import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        site: resolve(fileURLToPath(new URL(".", import.meta.url)), "index.html"),
        magicLink: resolve(fileURLToPath(new URL(".", import.meta.url)), "customer-magic-link.html"),
        purchaseSuccess: resolve(fileURLToPath(new URL(".", import.meta.url)), "purchase-success.html"),
      },
    },
  },
});
