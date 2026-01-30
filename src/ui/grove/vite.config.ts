import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", ".."); // <repo>/src/ui/grove -> <repo>

export default defineConfig({
  plugins: [react()],
  base: "/grove/",
  publicDir: path.resolve(__dirname, "public"),
  build: {
    outDir: path.resolve(repoRoot, "dist", "ui", "grove"),
    emptyOutDir: false, // `scripts/build-ui.mjs` owns dist cleanup.
    lib: {
      entry: path.resolve(__dirname, "src", "index.tsx"),
      formats: ["es"],
      fileName: () => "mycelium-grove.mjs",
    },
    rollupOptions: {
      output: {
        assetFileNames: "mycelium-grove.[ext]",
      },
    },
  },
});
