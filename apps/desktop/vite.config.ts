import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    server: {
        port: 5173,
        strictPort: true,
    },
    // Vitest consumes this block when the test toolchain is installed.
    // The regular Vite runtime ignores it.
    // @ts-expect-error Vitest augments Vite config with `test`.
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: "./src/test/setup.ts",
        clearMocks: true,
        restoreMocks: true,
        css: true,
    },
});
