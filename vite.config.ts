import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    host: "127.0.0.1",
  },
  build: {
    target: "es2022",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
