import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

function manualChunks(id: string) {
    if (!id.includes("node_modules")) {
        return;
    }

    if (id.includes("/react/") || id.includes("/react-dom/")) {
        return "vendor-react";
    }
    if (id.includes("@codemirror")) {
        return "vendor-codemirror";
    }
    if (
        id.includes("react-force-graph") ||
        id.includes("three") ||
        id.includes("force-graph") ||
        id.includes("3d-force-graph") ||
        id.includes("d3-force-3d")
    ) {
        return "vendor-graph";
    }
    if (id.includes("pdfjs-dist")) {
        return "vendor-pdf";
    }
    if (id.includes("@xterm") || id.includes("/xterm")) {
        return "vendor-terminal";
    }
    if (id.includes("katex")) {
        return "vendor-katex";
    }
}

export default defineConfig({
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    resolve: {
        dedupe: ["react", "react-dom"],
        alias: [
            {
                find: "react",
                replacement: fileURLToPath(
                    new URL("./node_modules/react", import.meta.url),
                ),
            },
            {
                find: "react-dom",
                replacement: fileURLToPath(
                    new URL("./node_modules/react-dom", import.meta.url),
                ),
            },
        ],
    },
    build: {
        // The desktop app intentionally ships several large lazy chunks
        // (CodeMirror languages, graph tooling, Mermaid definitions).
        // The default 500 kB warning threshold is too noisy for this bundle shape.
        chunkSizeWarningLimit: 2000,
        rollupOptions: {
            output: {
                manualChunks,
            },
        },
    },
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
