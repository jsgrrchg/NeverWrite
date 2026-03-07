import {
    WebviewWindow,
    getAllWebviewWindows,
    getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type { Tab } from "./store/editorStore";

const DETACHED_WINDOW_PREFIX = "note";
const DETACHED_WINDOW_STORAGE_PREFIX = "vaultai:detached-window:";
const DETACH_WINDOW_WIDTH = 960;
const DETACH_WINDOW_HEIGHT = 720;
const DETACH_OUTSIDE_MARGIN = 18;
const TAB_DROP_ZONE_HEIGHT = 96;
export const ATTACH_EXTERNAL_TAB_EVENT = "vaultai:attach-external-tab";

export interface DetachedWindowPayload {
    tabs: Tab[];
    activeTabId: string | null;
}

export interface AttachExternalTabPayload {
    tab: Tab;
}

export function getWindowMode() {
    const params = new URLSearchParams(window.location.search);
    const w = params.get("window");
    if (w === "note") return "note";
    if (w === "settings") return "settings";
    return "main";
}

export function getCurrentWindowLabel() {
    return getCurrentWebviewWindow().label;
}

function getDetachedWindowStorageKey(label: string) {
    return `${DETACHED_WINDOW_STORAGE_PREFIX}${label}`;
}

export function readDetachedWindowPayload(label: string) {
    const raw = window.localStorage.getItem(getDetachedWindowStorageKey(label));
    if (!raw) return null;
    window.localStorage.removeItem(getDetachedWindowStorageKey(label));

    try {
        const parsed = JSON.parse(raw) as DetachedWindowPayload;
        if (!Array.isArray(parsed.tabs)) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function createDetachedWindowPayload(tab: Tab): DetachedWindowPayload {
    return {
        tabs: [tab],
        activeTabId: tab.id,
    };
}

export function isPointerOutsideCurrentWindow(
    clientX: number,
    clientY: number,
) {
    return (
        clientX < -DETACH_OUTSIDE_MARGIN ||
        clientY < -DETACH_OUTSIDE_MARGIN ||
        clientX > window.innerWidth + DETACH_OUTSIDE_MARGIN ||
        clientY > window.innerHeight + DETACH_OUTSIDE_MARGIN
    );
}

export async function findWindowTabDropTarget(
    screenX: number,
    screenY: number,
    excludeLabel: string,
) {
    const windows = await getAllWebviewWindows();

    const candidates = await Promise.all(
        windows
            .filter((window) => window.label !== excludeLabel)
            .map(async (window) => {
                const [position, size, minimized, visible] = await Promise.all([
                    window.outerPosition(),
                    window.outerSize(),
                    window.isMinimized(),
                    window.isVisible(),
                ]);

                return {
                    label: window.label,
                    left: position.x,
                    top: position.y,
                    right: position.x + size.width,
                    bottom: position.y + size.height,
                    minimized,
                    visible,
                };
            }),
    );

    const match = candidates.find(
        (window) =>
            window.visible &&
            !window.minimized &&
            screenX >= window.left &&
            screenX <= window.right &&
            screenY >= window.top &&
            screenY <= window.top + TAB_DROP_ZONE_HEIGHT,
    );

    return match?.label ?? null;
}

export async function openSettingsWindow() {
    const label = "settings";
    const existing = await getAllWebviewWindows();
    const settingsWin = existing.find((w) => w.label === label);
    if (settingsWin) {
        await settingsWin.show();
        await settingsWin.setFocus();
        return;
    }
    const win = new WebviewWindow(label, {
        url: "/?window=settings",
        title: "Settings — VaultAI",
        width: 820,
        height: 560,
        minWidth: 640,
        minHeight: 480,
        center: true,
        focus: true,
        titleBarStyle: "overlay",
        hiddenTitle: true,
        trafficLightPosition: { x: 14, y: 18 },
    });
    await new Promise<void>((resolve, reject) => {
        void win.once("tauri://created", () => resolve());
        void win.once("tauri://error", (e) => reject(e.payload));
    });
}

export async function openVaultWindow(vaultPath: string) {
    const label = `vault-${crypto.randomUUID()}`;
    const win = new WebviewWindow(label, {
        url: `/?vault=${encodeURIComponent(vaultPath)}`,
        title: vaultPath.split("/").pop() ?? "Vault",
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        center: true,
        focus: true,
        titleBarStyle: "overlay",
        hiddenTitle: true,
    });

    return await new Promise<void>((resolve, reject) => {
        void win.once("tauri://created", () => resolve());
        void win.once("tauri://error", (e) => reject(e.payload));
    });
}

export async function openDetachedNoteWindow(
    payload: DetachedWindowPayload,
    options?: { title?: string },
) {
    const label = `${DETACHED_WINDOW_PREFIX}-${crypto.randomUUID()}`;
    window.localStorage.setItem(
        getDetachedWindowStorageKey(label),
        JSON.stringify(payload),
    );

    const detachedWindow = new WebviewWindow(label, {
        url: "/?window=note",
        title: options?.title ?? payload.tabs[0]?.title ?? "Note",
        width: DETACH_WINDOW_WIDTH,
        height: DETACH_WINDOW_HEIGHT,
        minWidth: 520,
        minHeight: 360,
        center: true,
        focus: true,
        titleBarStyle: "overlay",
        hiddenTitle: true,
    });

    return await new Promise<WebviewWindow>((resolve, reject) => {
        void detachedWindow.once("tauri://created", () => {
            resolve(detachedWindow);
        });
        void detachedWindow.once("tauri://error", (event) => {
            window.localStorage.removeItem(getDetachedWindowStorageKey(label));
            reject(event.payload);
        });
    });
}
