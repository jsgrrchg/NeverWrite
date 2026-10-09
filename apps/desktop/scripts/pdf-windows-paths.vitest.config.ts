import { defineConfig } from "vitest/config";

// Temporary issue #519 investigation: real filesystem and Rust, no DOM mocks.
export default defineConfig({
    test: {
        environment: "node",
        include: ["scripts/pdf-windows-paths.integration.test.ts"],
        hookTimeout: 60_000,
        testTimeout: 30_000,
    },
});
