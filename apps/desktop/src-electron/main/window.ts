import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeTheme } from "electron";
import { ELECTRON_IPC } from "../shared/ipc";
import { removeWindowVaultRoute } from "./shellState";

const DEFAULT_WIDTH = 1480;
const DEFAULT_HEIGHT = 960;
const MIN_WIDTH = 700;
const MIN_HEIGHT = 560;

// Traffic-light Y is chosen to vertically center the ~12px native buttons
// inside the 34px WindowChrome tab bar: (34 - 12) / 2 = 11. The renderer
// uses the same origin (see `getTrafficLightPosition` in utils/platform.ts)
// so main-provided defaults and renderer overrides stay in sync. When the
// two disagree the tab bar drifts past the traffic lights — exactly the
// tear-off regression reported after the Tauri → Electron move.
const TRAFFIC_LIGHT_X = 14;
const TRAFFIC_LIGHT_Y = 11;

function getDefaultTrafficLightPosition(): { x: number; y: number } {
    return { x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_Y };
}

function readTrafficLightPosition(
    options: Record<string, unknown> | undefined,
): { x: number; y: number } {
    const raw = options?.trafficLightPosition;
    if (raw && typeof raw === "object") {
        const record = raw as Record<string, unknown>;
        if (
            typeof record.x === "number" &&
            typeof record.y === "number" &&
            Number.isFinite(record.x) &&
            Number.isFinite(record.y)
        ) {
            return { x: record.x, y: record.y };
        }
    }
    return getDefaultTrafficLightPosition();
}

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

function getOptionalNumber(
    options: Record<string, unknown> | undefined,
    key: string,
): number | undefined {
    const value = options?.[key];
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
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

    // A "chromeless" window is a transient overlay (drag ghost preview, etc.)
    // that opts out of the full titlebar chrome by passing decorations:false.
    // These must not get hiddenInset, vibrancy, or traffic lights — otherwise
    // Electron still paints a traffic-light inset over a transparent frame
    // which leaks through as a dark halo.
    const chromeless = options?.decorations === false;

    // The main window and the settings window both render a tinted left
    // sidebar / top bar that covers the leading inset, so sidebar vibrancy
    // plays nicely on them. Other satellites (drag ghost previews, detached
    // panels) have no such chrome, so vibrancy would leave the traffic lights
    // floating over the wallpaper — keep those anchored to a solid theme
    // background.
    const isMainWindow = label === "main";
    const isSettingsWindow = label === "settings";
    const supportsWindowMaterial =
        !chromeless && (isMainWindow || isSettingsWindow);
    const usesVibrancy = isMac && supportsWindowMaterial;
    const solidChromeFallback = nativeTheme.shouldUseDarkColors
        ? "#18181b"
        : "#fafafa";

    const initialX = getOptionalNumber(options, "x");
    const initialY = getOptionalNumber(options, "y");
    const hasExplicitPosition = initialX !== undefined || initialY !== undefined;
    const wantsCenter = !hasExplicitPosition
        && getBooleanOption(options, "center", false);
    const wantsShow = getBooleanOption(options, "visible", true);
    const wantsFocus = getBooleanOption(options, "focus", true);

    // Only satellite windows get a custom trafficLightPosition. The main
    // window keeps titleBarStyle:"hiddenInset" (below) which places the
    // buttons at the macOS-native spot — overriding that position here
    // would drift the buttons away from the sidebar-toggle row.
    const trafficLightPosition = isMac && !chromeless && !isMainWindow
        ? readTrafficLightPosition(options)
        : undefined;

    // Windows decoration strategy mirrors the working setup in `Comando`:
    // do NOT set `frame` or `transparent` explicitly when the window opts
    // into the native acrylic chrome. Combining `titleBarStyle: "hidden"`
    // with `backgroundMaterial: "acrylic"` and a transparent
    // `titleBarOverlay` lets DWM paint the acrylic surface and caption
    // buttons natively. Setting `frame: true` or `transparent: false`
    // alongside acrylic was observed to suppress the material entirely
    // (sidebars went literally see-through to the desktop) and to swallow
    // the native caption buttons.
    const isWindowsAcrylic = isWindows && !chromeless;
    const windowsCaptionSymbol = nativeTheme.shouldUseDarkColors
        ? "#f4f4f5"
        : "#1c1c1c";

    const window = new BrowserWindow({
        title: getTitle(label, options),
        width: getNumberOption(options, "width", DEFAULT_WIDTH),
        height: getNumberOption(options, "height", DEFAULT_HEIGHT),
        minWidth: getNumberOption(options, "minWidth", MIN_WIDTH),
        minHeight: getNumberOption(options, "minHeight", MIN_HEIGHT),
        x: initialX,
        y: initialY,
        center: wantsCenter,
        show: wantsShow,
        resizable: getBooleanOption(options, "resizable", true),
        skipTaskbar: getBooleanOption(options, "skipTaskbar", false),
        alwaysOnTop: getBooleanOption(options, "alwaysOnTop", false),
        ...(chromeless
            ? {
                  frame: false,
                  transparent: getBooleanOption(options, "transparent", true),
              }
            : {}),
        backgroundColor: chromeless
            ? "#00000000"
            : usesVibrancy || isWindowsAcrylic
                ? "#00000000"
                : isMac
                    ? solidChromeFallback
                    : "#ffffff",
        backgroundMaterial: isWindowsAcrylic ? "acrylic" : undefined,
        // macOS split:
        //  - main window: "hiddenInset" keeps macOS' native traffic-light
        //    placement aligned with the sidebar-toggle row, as it was pre-
        //    migration.
        //  - satellite windows: "hidden" so our explicit trafficLightPosition
        //    is honored verbatim — "hiddenInset" adds an implicit vertical
        //    offset that changed on macOS ≥ 26 (Tahoe) with the NSButton
        //    resize (VSCode hit the same regression: microsoft/vscode#279769).
        titleBarStyle: chromeless
            ? "default"
            : isMac
                ? (isMainWindow ? "hiddenInset" : "hidden")
                : isWindows
                    ? "hidden"
                    : "default",
        titleBarOverlay: isWindowsAcrylic
            ? {
                  color: "#00000000",
                  height: 34,
                  symbolColor: windowsCaptionSymbol,
              }
            : undefined,
        trafficLightPosition,
        vibrancy: usesVibrancy ? "sidebar" : undefined,
        visualEffectState: usesVibrancy ? "active" : undefined,
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

    // When the renderer asks for focus alongside an auto-shown window, defer
    // the focus call until the web contents are actually ready to paint so
    // the new satellite window raises above its parent instead of flashing
    // under it.
    if (wantsShow && wantsFocus) {
        window.once("ready-to-show", () => {
            if (window.isDestroyed()) return;
            window.focus();
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
                // whenever we bring them back. Skip the main window: it uses
                // the native hiddenInset placement and setting any position
                // would shift it away from that default.
                if (visible && label !== "main") {
                    window.setWindowButtonPosition(
                        getDefaultTrafficLightPosition(),
                    );
                }
            }
            return null;
        case "setTitleBarOverlay":
            // Windows only: theme the native titleBarOverlay symbol/background
            // color so the caption buttons stay legible against the acrylic
            // surface in both light and dark themes. No-op elsewhere because
            // the API is only meaningful on Windows titleBarOverlay windows.
            if (process.platform === "win32") {
                const overlay: Parameters<
                    BrowserWindow["setTitleBarOverlay"]
                >[0] = {};
                if (typeof args?.color === "string") {
                    overlay.color = args.color;
                }
                if (typeof args?.symbolColor === "string") {
                    overlay.symbolColor = args.symbolColor;
                }
                if (typeof args?.height === "number") {
                    overlay.height = Math.round(args.height);
                }
                if (Object.keys(overlay).length > 0) {
                    window.setTitleBarOverlay(overlay);
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
