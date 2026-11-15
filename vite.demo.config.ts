// Builds the website's live app demo (src/demo) into dist-demo/, which
// `pnpm build:demo` then copies to the website's public/app-demo/.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  base: "./",
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: path.resolve(__dirname, "demo.html") },
  },
});
