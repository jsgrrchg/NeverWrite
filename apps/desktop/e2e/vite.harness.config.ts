import { fileURLToPath, URL } from "node:url";
import { defineConfig, mergeConfig } from "vite";

import baseConfig from "../vite.config";

export default mergeConfig(
    baseConfig,
    defineConfig({
        root: fileURLToPath(new URL("./harness", import.meta.url)),
        server: {
            port: 5180,
            strictPort: true,
        },
        build: {
            outDir: fileURLToPath(new URL("./dist", import.meta.url)),
        },
    }),
);
