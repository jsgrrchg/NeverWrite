import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

const CHROME_EXTENSION_PUBLIC_KEY =
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA03lEJ4MBGAMV/SDSJZE4WTsiiTKq2VOEqZNj1qgHfY1vsi5obhoZ8UHD3soC8KrX1AeFUSPmRJri7e3V4m/zFjDEyvGXrKJn0v7h7FrTf2Qb0PgrXjFKycIFHJV5aTygh4KjAo6bKKKOZucn9nb7Rx76bpgg1SVyZWXl7J7QsFexvKLoP8psYq56Bj2hf/G0YRIU3ZUp+00Hyz16Uaro7FaY0HdhOHETNr2J0MiA4xvoAx0NnmIkmioQF67TFRnd4JE1Dd8crsH7dsO0/CwgvSE1jyDbdh7nwrn5Rli0tksjBaKSWGoGrWJq2hZFILxK4DOtSPGpxn2yPTNuceSD7QIDAQAB";
const FIREFOX_EXTENSION_ID = "web-clipper@vaultai.app";

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
        description: "Clip web content directly into your VaultAI vault.",
        key: CHROME_EXTENSION_PUBLIC_KEY,
        permissions: ["contextMenus", "storage"],
        browser_specific_settings: {
            gecko: {
                id: FIREFOX_EXTENSION_ID,
            },
        },
        action: {
            default_title: "Open VaultAI Web Clipper",
        },
        commands: {
            _execute_action: {
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
