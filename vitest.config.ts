import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Frontend unit tests (`pnpm test`). The Tauri backend is mocked in each test, so
// nothing here touches real data.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
