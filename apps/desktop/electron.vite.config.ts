import fs from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type UserConfig } from "vite";

const target = process.env.NEVERWRITE_ELECTRON_TARGET ?? "renderer";
const packageJson = JSON.parse(
    fs.readFileSync(
        fileURLToPath(new URL("./package.json", import.meta.url)),
        "utf8",
    ),
) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};
const runtimeAlias = fileURLToPath(
    new URL("./src/app/runtime/index.ts", import.meta.url),
);
const dependencyExternal = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
];
const nodeExternal = [
    "electron",
    ...builtinModules,
    ...builtinModules.map((moduleName) => `node:${moduleName}`),
    ...dependencyExternal,
];

function electronProcessConfig(kind: "main" | "preload"): UserConfig {
    const isPreload = kind === "preload";
    return {
        build: {
            outDir: `out/electron/${kind}`,
            emptyOutDir: true,
            sourcemap: true,
            lib: {
                entry: fileURLToPath(
                    new URL(`./src-electron/${kind}/index.ts`, import.meta.url),
                ),
                formats: [isPreload ? "cjs" : "es"],
                fileName: () => (isPreload ? "index.cjs" : "index.js"),
            },
            rollupOptions: {
                external: nodeExternal,
            },
        },
    };
}

function rendererConfig(): UserConfig {
    return {
        plugins: [react(), tailwindcss()],
        resolve: {
            dedupe: ["react", "react-dom"],
            alias: [
                {
                    find: "@neverwrite/runtime",
                    replacement: runtimeAlias,
                },
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
            outDir: "out/electron/renderer",
            chunkSizeWarningLimit: 2000,
            rollupOptions: {
                input: fileURLToPath(new URL("./index.html", import.meta.url)),
            },
        },
        server: {
            port: 5174,
            strictPort: true,
        },
    };
}

export default defineConfig(() => {
    if (target === "main" || target === "preload") {
        return electronProcessConfig(target);
    }
    return rendererConfig();
});
