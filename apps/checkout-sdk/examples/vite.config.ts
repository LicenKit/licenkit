import { fileURLToPath, URL } from "node:url";
import { copyFileSync, mkdirSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    {
      name: "copy-reference-security-headers",
      closeBundle() {
        const outputRoot = fileURLToPath(new URL("../dist/examples", import.meta.url));
        for (const example of ["react-vite", "vanilla"]) {
          const outputDir = `${outputRoot}/${example}`;
          mkdirSync(outputDir, { recursive: true });
          copyFileSync(
            fileURLToPath(new URL(`./${example}/_headers`, import.meta.url)),
            `${outputDir}/_headers`,
          );
        }
      },
    },
  ],
  build: {
    outDir: fileURLToPath(new URL("../dist/examples", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "react-vite": fileURLToPath(new URL("./react-vite/index.html", import.meta.url)),
        "react-vite-success": fileURLToPath(new URL("./react-vite/success.html", import.meta.url)),
        vanilla: fileURLToPath(new URL("./vanilla/index.html", import.meta.url)),
        "vanilla-success": fileURLToPath(new URL("./vanilla/success.html", import.meta.url)),
      },
    },
  },
});
