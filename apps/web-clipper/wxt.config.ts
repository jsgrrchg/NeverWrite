import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
    srcDir: "src",
    publicDir: "src/assets",
    manifestVersion: 3,
    targetBrowsers: ["chrome", "firefox"],
    modules: ["@wxt-dev/module-react"],
    vite: () => ({
        plugins: [tailwindcss()],
    }),
    manifest: {
        name: "VaultAI Web Clipper",
        short_name: "VaultAI Clipper",
        description:
            "Clip web content into VaultAI using a dedicated extension window.",
        permissions: ["contextMenus"],
        action: {
            default_title: "Open VaultAI Web Clipper",
        },
        commands: {
            "open-clipper": {
                suggested_key: {
                    default: "Ctrl+Shift+S",
                    mac: "Command+Shift+S",
                },
                description: "Open VaultAI Web Clipper",
            },
        },
        side_panel: {
            default_path: "/sidepanel.html",
        },
        icons: {
            16: "/icons/icon-16.png",
            32: "/icons/icon-32.png",
            48: "/icons/icon-48.png",
            128: "/icons/icon-128.png",
        },
    },
});
