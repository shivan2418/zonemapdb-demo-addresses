import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // Relative, so the same build works at a GitHub Pages project path (/block-addresses/).
  base: "./",
  plugins: [svelte()],
  // The search worker imports modules (zonemapdb), so it's built as an ES module worker.
  worker: { format: "es" },
});
