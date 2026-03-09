import {
    WebviewWindow,
    getAllWebviewWindows,
    getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import type { Tab } from "./store/editorStore";

const DETACHED_WINDOW_PREFIX = "note";
const DETACHED_WINDOW_STORAGE_PREFIX = "vaultai:detached-window:";
const DETACH_WINDOW_WIDTH = 960;
const DETACH_WINDOW_HEIGHT = 720;
const DETACH_OUTSIDE_MARGIN = 30;
const TAB_DROP_ZONE_HEIGHT = 128;
const TAB_DROP_ZONE_TOP_PADDING = 22;
const TAB_DROP_ZONE_SIDE_PADDING = 28;
const DETACHED_WINDOW_CURSOR_OFFSET_X = 120;
const DETACHED_WINDOW_CURSOR_OFFSET_Y = 18;
const TRAFFIC_LIGHT_X = 14;
const TRAFFIC_LIGHT_Y = 22;
const SETTINGS_TRAFFIC_LIGHT_Y = 20;
const VAULT_TRAFFIC_LIGHT_Y = 20;
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

function getTrafficLightPosition() {
    return new LogicalPosition(TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y);
}

function getSettingsTrafficLightPosition() {
    return new LogicalPosition(TRAFFIC_LIGHT_X, SETTINGS_TRAFFIC_LIGHT_Y);
}

function getVaultTrafficLightPosition() {
    return new LogicalPosition(TRAFFIC_LIGHT_X, VAULT_TRAFFIC_LIGHT_Y);
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
            .filter(
                (window) =>
                    window.label !== excludeLabel &&
                    window.label !== "settings",
            )
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

    const match = candidates
        .filter(
            (window) =>
                window.visible &&
                !window.minimized &&
                screenX >= window.left - TAB_DROP_ZONE_SIDE_PADDING &&
                screenX <= window.right + TAB_DROP_ZONE_SIDE_PADDING &&
                screenY >= window.top - TAB_DROP_ZONE_TOP_PADDING &&
                screenY <= window.top + TAB_DROP_ZONE_HEIGHT,
        )
        .sort((left, right) => {
            const leftInsideHeader =
                screenX >= left.left &&
                screenX <= left.right &&
                screenY >= left.top &&
                screenY <= left.top + TAB_DROP_ZONE_HEIGHT;
            const rightInsideHeader =
                screenX >= right.left &&
                screenX <= right.right &&
                screenY >= right.top &&
                screenY <= right.top + TAB_DROP_ZONE_HEIGHT;

            if (leftInsideHeader !== rightInsideHeader) {
                return leftInsideHeader ? -1 : 1;
            }

            return Math.abs(screenY - left.top) - Math.abs(screenY - right.top);
        })[0];

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
        trafficLightPosition: getSettingsTrafficLightPosition(),
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
        trafficLightPosition: getVaultTrafficLightPosition(),
    });

    return await new Promise<void>((resolve, reject) => {
        void win.once("tauri://created", () => resolve());
        void win.once("tauri://error", (e) => reject(e.payload));
    });
}

export async function openDetachedNoteWindow(
    payload: DetachedWindowPayload,
    options?: {
        title?: string;
        position?: { x: number; y: number };
    },
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
        center: options?.position === undefined,
        x: options?.position?.x,
        y: options?.position?.y,
        focus: true,
        preventOverflow: true,
        titleBarStyle: "overlay",
        hiddenTitle: true,
        trafficLightPosition: getTrafficLightPosition(),
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

export function getDetachedWindowPosition(screenX: number, screenY: number) {
    return {
        x: Math.max(0, Math.round(screenX - DETACHED_WINDOW_CURSOR_OFFSET_X)),
        y: Math.max(0, Math.round(screenY - DETACHED_WINDOW_CURSOR_OFFSET_Y)),
    };
}
