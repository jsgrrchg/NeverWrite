import {
    WebviewWindow,
    getAllWebviewWindows,
    getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import type { Tab } from "./store/editorStore";
import { getPathBaseName } from "./utils/path";
import { getTrafficLightPosition } from "./utils/platform";

const DETACHED_WINDOW_PREFIX = "note";
const DETACHED_WINDOW_STORAGE_PREFIX = "vaultai:detached-window:";
const WINDOW_TAB_DROP_ZONE_STORAGE_PREFIX = "vaultai:window-tab-drop-zone:";
const DETACH_WINDOW_WIDTH = 960;
const DETACH_WINDOW_HEIGHT = 720;
const DETACH_OUTSIDE_MARGIN = 30;
const DETACHED_WINDOW_CURSOR_OFFSET_X = 120;
const DETACHED_WINDOW_CURSOR_OFFSET_Y = 18;
export const ATTACH_EXTERNAL_TAB_EVENT = "vaultai:attach-external-tab";

export interface DetachedWindowPayload {
    tabs: Tab[];
    activeTabId: string | null;
    vaultPath: string | null;
}

export interface AttachExternalTabPayload {
    tab: Tab;
}

export interface WindowTabDropZoneBounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
    vaultPath: string | null;
}

interface StoredWindowTabDropZoneBounds extends WindowTabDropZoneBounds {
    updatedAt: number;
}

interface WindowTabDropTargetCandidate extends WindowTabDropZoneBounds {
    label: string;
    minimized: boolean;
    visible: boolean;
    updatedAt: number;
}

export function getWindowMode() {
    const params = new URLSearchParams(window.location.search);
    const w = params.get("window");
    if (w === "note") return "note";
    if (w === "settings") return "settings";
    if (w === "ghost") return "ghost";
    return "main";
}

export function getCurrentWindowLabel() {
    return getCurrentWebviewWindow().label;
}

function getTrafficLightLogicalPosition() {
    const pos = getTrafficLightPosition();
    return new LogicalPosition(pos.x, pos.y);
}

function getDetachedWindowStorageKey(label: string) {
    return `${DETACHED_WINDOW_STORAGE_PREFIX}${label}`;
}

function getWindowTabDropZoneStorageKey(label: string) {
    return `${WINDOW_TAB_DROP_ZONE_STORAGE_PREFIX}${label}`;
}

export function getDetachedNoteWindowUrl(vaultPath: string | null) {
    if (!vaultPath) return "/?window=note";
    return `/?window=note&vault=${encodeURIComponent(vaultPath)}`;
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

export function createDetachedWindowPayload(
    tab: Tab,
    vaultPath: string | null,
): DetachedWindowPayload {
    return {
        tabs: [tab],
        activeTabId: tab.id,
        vaultPath,
    };
}

export function publishWindowTabDropZone(
    label: string,
    bounds: WindowTabDropZoneBounds | null,
) {
    const key = getWindowTabDropZoneStorageKey(label);
    if (!bounds) {
        window.localStorage.removeItem(key);
        return;
    }

    const stored: StoredWindowTabDropZoneBounds = {
        ...bounds,
        updatedAt: Date.now(),
    };
    window.localStorage.setItem(key, JSON.stringify(stored));
}

function readWindowTabDropZone(label: string) {
    const raw = window.localStorage.getItem(
        getWindowTabDropZoneStorageKey(label),
    );
    if (!raw) return null;

    try {
        const parsed = JSON.parse(
            raw,
        ) as Partial<StoredWindowTabDropZoneBounds>;
        if (
            typeof parsed.left !== "number" ||
            typeof parsed.top !== "number" ||
            typeof parsed.right !== "number" ||
            typeof parsed.bottom !== "number"
        ) {
            return null;
        }

        return {
            left: parsed.left,
            top: parsed.top,
            right: parsed.right,
            bottom: parsed.bottom,
            vaultPath:
                typeof parsed.vaultPath === "string" ||
                parsed.vaultPath === null
                    ? parsed.vaultPath
                    : null,
            updatedAt:
                typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
        } satisfies StoredWindowTabDropZoneBounds;
    } catch {
        return null;
    }
}

function pointIsInsideBounds(
    screenX: number,
    screenY: number,
    bounds: WindowTabDropZoneBounds,
) {
    return (
        screenX >= bounds.left &&
        screenX <= bounds.right &&
        screenY >= bounds.top &&
        screenY <= bounds.bottom
    );
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
    vaultPath: string | null,
) {
    const windows = await getAllWebviewWindows();

    const candidates = await Promise.all(
        windows
            .filter(
                (window) =>
                    window.label !== excludeLabel &&
                    window.label !== "settings" &&
                    !window.label.startsWith("ghost-"),
            )
            .map(async (window) => {
                const bounds = readWindowTabDropZone(window.label);
                if (!bounds || bounds.vaultPath !== vaultPath) {
                    return null;
                }

                const [minimized, visible] = await Promise.all([
                    window.isMinimized(),
                    window.isVisible(),
                ]);

                return {
                    label: window.label,
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom,
                    vaultPath: bounds.vaultPath,
                    minimized,
                    visible,
                    updatedAt: bounds.updatedAt,
                };
            }),
    );

    const match = candidates
        .filter(
            (window): window is WindowTabDropTargetCandidate =>
                window !== null &&
                window.visible &&
                !window.minimized &&
                pointIsInsideBounds(screenX, screenY, window),
        )
        .sort((left, right) => {
            const leftCenterX = (left.left + left.right) / 2;
            const leftCenterY = (left.top + left.bottom) / 2;
            const rightCenterX = (right.left + right.right) / 2;
            const rightCenterY = (right.top + right.bottom) / 2;
            const leftDistance = Math.hypot(
                screenX - leftCenterX,
                screenY - leftCenterY,
            );
            const rightDistance = Math.hypot(
                screenX - rightCenterX,
                screenY - rightCenterY,
            );

            if (leftDistance !== rightDistance) {
                return leftDistance - rightDistance;
            }

            return right.updatedAt - left.updatedAt;
        })[0];

    return match?.label ?? null;
}

function settingsWindowLabel(vaultPath: string | null): string {
    if (!vaultPath) return "settings";
    // Deterministic, Tauri-safe label derived from the vault path
    let hash = 5381;
    for (let i = 0; i < vaultPath.length; i++) {
        hash = (((hash << 5) + hash) ^ vaultPath.charCodeAt(i)) >>> 0;
    }
    return `settings-${hash.toString(36)}`;
}

export async function openSettingsWindow(vaultPath: string | null = null) {
    const label = settingsWindowLabel(vaultPath);
    const existing = await getAllWebviewWindows();
    const settingsWin = existing.find((w) => w.label === label);
    if (settingsWin) {
        await settingsWin.show();
        await settingsWin.setFocus();
        return;
    }
    const url = vaultPath
        ? `/?window=settings&vault=${encodeURIComponent(vaultPath)}`
        : "/?window=settings";
    const win = new WebviewWindow(label, {
        url,
        title: "Settings — VaultAI",
        width: 820,
        height: 560,
        minWidth: 640,
        minHeight: 480,
        center: true,
        focus: true,
        titleBarStyle: "overlay",
        hiddenTitle: true,
        trafficLightPosition: getTrafficLightLogicalPosition(),
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
        title: getPathBaseName(vaultPath) || "Vault",
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        center: true,
        focus: true,
        titleBarStyle: "overlay",
        hiddenTitle: true,
        trafficLightPosition: getTrafficLightLogicalPosition(),
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
        url: getDetachedNoteWindowUrl(payload.vaultPath),
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
        trafficLightPosition: getTrafficLightLogicalPosition(),
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

// ---------------------------------------------------------------------------
// Ghost drag preview window
// ---------------------------------------------------------------------------

const GHOST_WINDOW_WIDTH = 200;
const GHOST_WINDOW_HEIGHT = 36;
const GHOST_CURSOR_OFFSET_X = 20;
const GHOST_CURSOR_OFFSET_Y = 12;

function getGhostWindowPosition(screenX: number, screenY: number) {
    return {
        x: Math.max(0, Math.round(screenX - GHOST_CURSOR_OFFSET_X)),
        y: Math.max(0, Math.round(screenY - GHOST_CURSOR_OFFSET_Y)),
    };
}

export async function createGhostWindow(
    title: string,
    screenX: number,
    screenY: number,
): Promise<WebviewWindow> {
    const label = `ghost-${crypto.randomUUID()}`;
    const pos = getGhostWindowPosition(screenX, screenY);

    const ghost = new WebviewWindow(label, {
        url: `/?window=ghost&title=${encodeURIComponent(title)}`,
        title: "",
        width: GHOST_WINDOW_WIDTH,
        height: GHOST_WINDOW_HEIGHT,
        resizable: false,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        focus: false,
        visible: false,
        x: pos.x,
        y: pos.y,
    });

    await new Promise<void>((resolve, reject) => {
        void ghost.once("tauri://created", () => resolve());
        void ghost.once("tauri://error", (e) => reject(e.payload));
    });

    await ghost.setIgnoreCursorEvents(true);
    await ghost.show();

    return ghost;
}

export async function moveGhostWindow(
    ghost: WebviewWindow,
    screenX: number,
    screenY: number,
) {
    const pos = getGhostWindowPosition(screenX, screenY);
    await ghost.setPosition(new LogicalPosition(pos.x, pos.y));
}

export async function destroyGhostWindow(ghost: WebviewWindow) {
    try {
        await ghost.destroy();
    } catch {
        // Window already closed
    }
}
