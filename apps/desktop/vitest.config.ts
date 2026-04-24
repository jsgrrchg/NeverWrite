import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
    viteConfig,
    defineConfig({
        test: {
            environment: "jsdom",
            globals: true,
            setupFiles: "./src/test/setup.ts",
            clearMocks: true,
            restoreMocks: true,
            css: true,
            include: [
                "src/**/*.test.ts",
                "src/**/*.test.tsx",
                "src-electron/**/*.test.ts",
                "src-electron/**/*.test.tsx",
            ],
            exclude: ["scripts/**/*.test.mjs"],
        },
    }),
);
