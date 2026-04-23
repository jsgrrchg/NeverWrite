import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { ELECTRON_IPC } from "../shared/ipc";
import { removeWindowVaultRoute } from "./shellState";

const DEFAULT_WIDTH = 1480;
const DEFAULT_HEIGHT = 960;
const MIN_WIDTH = 700;
const MIN_HEIGHT = 560;

// Custom traffic-light position on macOS. Kept in one place so both the
// BrowserWindow constructor and `setWindowButtonVisibility` callers can
// re-apply it — Electron resets the position back to the macOS default when
// the buttons are hidden and shown again, so we re-assert it on show.
const MAC_TRAFFIC_LIGHT_POSITION = { x: 14, y: 20 } as const;

const windowsByLabel = new Map<string, BrowserWindow>();
const labelsByWebContentsId = new Map<number, string>();

function preloadPath() {
    return fileURLToPath(
        new URL(/* @vite-ignore */ "../preload/index.cjs", import.meta.url),
    );
}

function rendererHtmlPath() {
    return fileURLToPath(
        new URL(/* @vite-ignore */ "../renderer/index.html", import.meta.url),
    );
}

export function resolveRendererDevUrl(
    rendererUrl: string | undefined,
    isPackaged: boolean,
    search: string,
) {
    const normalizedRendererUrl = rendererUrl?.trim();
    if (!normalizedRendererUrl || isPackaged) {
        return null;
    }

    const url = new URL(normalizedRendererUrl);
    url.search = search;
    return url.toString();
}

function resolveRendererEntry(search: string) {
    const rendererUrl = resolveRendererDevUrl(
        process.env.ELECTRON_RENDERER_URL,
        app.isPackaged,
        search,
    );
    if (!rendererUrl) {
        return {
            kind: "file",
            path: rendererHtmlPath(),
            search,
        } as const;
    }

    return {
        kind: "url",
        url: rendererUrl,
    } as const;
}

function normalizeSearch(search: string | undefined) {
    if (!search) return "";
    return search.startsWith("?") ? search : `?${search}`;
}

function getSearchFromUrl(rawUrl: unknown) {
    if (typeof rawUrl !== "string") return "";
    try {
        if (/^https?:\/\//i.test(rawUrl)) {
            return new URL(rawUrl).search;
        }
        const marker = rawUrl.indexOf("?");
        return marker === -1 ? "" : rawUrl.slice(marker);
    } catch {
        return "";
    }
}

function getTitle(label: string, options: Record<string, unknown> | undefined) {
    if (typeof options?.title === "string" && options.title.trim()) {
        return options.title;
    }
    if (label === "settings") return "Settings - NeverWrite";
    return "NeverWrite";
}

function getBooleanOption(
    options: Record<string, unknown> | undefined,
    key: string,
    fallback: boolean,
) {
    const value = options?.[key];
    return typeof value === "boolean" ? value : fallback;
}

function getNumberOption(
    options: Record<string, unknown> | undefined,
    key: string,
    fallback: number,
) {
    const value = options?.[key];
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : fallback;
}

function bindWindowLifecycle(label: string, window: BrowserWindow) {
    const webContentsId = window.webContents.id;
    windowsByLabel.set(label, window);
    labelsByWebContentsId.set(webContentsId, label);

    const forwardWindowEvent = (eventName: string) => {
        if (window.isDestroyed()) return;
        window.webContents.send(ELECTRON_IPC.windowEvent, { eventName });
    };

    window.on("moved", () => forwardWindowEvent("moved"));
    window.on("resized", () => forwardWindowEvent("resized"));
    window.on("enter-full-screen", () => forwardWindowEvent("scaleChanged"));
    window.on("leave-full-screen", () => forwardWindowEvent("scaleChanged"));
    window.webContents.on("did-finish-load", () => {
        if (window.isDestroyed()) return;
        window.webContents.executeJavaScript(
            `window.neverwriteWindowLabel = ${JSON.stringify(label)}`,
            true,
        ).catch(() => {});
    });
    window.on("closed", () => {
        windowsByLabel.delete(label);
        labelsByWebContentsId.delete(webContentsId);
        removeWindowVaultRoute(label);
    });
}

export function getWindowLabel(window: BrowserWindow | null) {
    if (!window) return "main";
    return labelsByWebContentsId.get(window.webContents.id) ?? "main";
}

export function getWindowByLabel(label: string | null | undefined) {
    if (!label) return BrowserWindow.getFocusedWindow() ?? windowsByLabel.get("main") ?? null;
    const window = windowsByLabel.get(label);
    if (!window || window.isDestroyed()) return null;
    return window;
}

export function getAllWindowInfos() {
    return [...windowsByLabel.entries()]
        .filter(([, window]) => !window.isDestroyed())
        .map(([label]) => ({ label }));
}

export function emitToWindow(label: string, eventName: string, payload: unknown) {
    const window = getWindowByLabel(label);
    if (!window) return false;
    window.webContents.send(ELECTRON_IPC.event, { eventName, payload });
    return true;
}

export function createAppWindow(
    label = "main",
    options: Record<string, unknown> | undefined = undefined,
) {
    const existing = getWindowByLabel(label);
    if (existing) {
        existing.show();
        existing.focus();
        return existing;
    }

    const isMac = process.platform === "darwin";
    const isWindows = process.platform === "win32";
    const search = normalizeSearch(
        getSearchFromUrl(options?.url) ||
            (typeof options?.search === "string" ? options.search : ""),
    );

    const window = new BrowserWindow({
        title: getTitle(label, options),
        width: getNumberOption(options, "width", DEFAULT_WIDTH),
        height: getNumberOption(options, "height", DEFAULT_HEIGHT),
        minWidth: getNumberOption(options, "minWidth", MIN_WIDTH),
        minHeight: getNumberOption(options, "minHeight", MIN_HEIGHT),
        show: getBooleanOption(options, "visible", true),
        backgroundColor: isMac || isWindows ? "#00000000" : "#ffffff",
        backgroundMaterial: isWindows ? "acrylic" : undefined,
        titleBarStyle: isMac ? "hiddenInset" : isWindows ? "hidden" : "default",
        titleBarOverlay: isWindows
            ? {
                  color: "#00000000",
                  height: 34,
                  symbolColor: "#f4f4f5",
              }
            : undefined,
        trafficLightPosition: isMac ? MAC_TRAFFIC_LIGHT_POSITION : undefined,
        vibrancy: isMac ? "sidebar" : undefined,
        visualEffectState: isMac ? "active" : undefined,
        webPreferences: {
            preload: preloadPath(),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    bindWindowLifecycle(label, window);

    const rendererEntry = resolveRendererEntry(search);
    if (rendererEntry.kind === "url") {
        void window.loadURL(rendererEntry.url);
    } else {
        void window.loadFile(rendererEntry.path, {
            search: rendererEntry.search,
        });
    }

    return window;
}

export function moveWindow(label: string | null, x: number, y: number) {
    const window = getWindowByLabel(label);
    if (!window) return;
    window.setPosition(Math.round(x), Math.round(y));
}

export function windowCommand(
    label: string | null,
    command: string,
    args?: Record<string, unknown>,
) {
    const window = getWindowByLabel(label);
    if (!window) {
        throw new Error(`Window not found: ${label ?? "focused"}`);
    }

    switch (command) {
        case "close":
            window.close();
            return null;
        case "minimize":
            window.minimize();
            return null;
        case "toggleMaximize":
            if (window.isMaximized()) window.unmaximize();
            else window.maximize();
            return null;
        case "isMaximized":
            return window.isMaximized();
        case "isMinimized":
            return window.isMinimized();
        case "isVisible":
            return window.isVisible();
        case "show":
            window.show();
            return null;
        case "focus":
            window.focus();
            return null;
        case "setPosition":
            moveWindow(
                label,
                typeof args?.x === "number" ? args.x : 0,
                typeof args?.y === "number" ? args.y : 0,
            );
            return null;
        case "setIgnoreCursorEvents":
            window.setIgnoreMouseEvents(Boolean(args?.ignore), {
                forward: true,
            });
            return null;
        case "setTrafficLightsVisible":
            // macOS only: hide/show the native window buttons. No-op elsewhere.
            if (process.platform === "darwin") {
                const visible = Boolean(args?.visible);
                window.setWindowButtonVisibility(visible);
                // Electron drops the custom trafficLightPosition when the
                // buttons are hidden and shown again, so we re-apply it here
                // whenever we bring them back. Otherwise the overlay reveal
                // flashes them at the macOS default offset.
                if (visible) {
                    window.setWindowButtonPosition(MAC_TRAFFIC_LIGHT_POSITION);
                }
            }
            return null;
        default:
            throw new Error(`Unsupported window command: ${command}`);
    }
}

export function clearWindowRegistryForTests() {
    windowsByLabel.clear();
    labelsByWebContentsId.clear();
}
