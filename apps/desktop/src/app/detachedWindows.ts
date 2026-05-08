import { emitTo } from "@neverwrite/runtime";
import {
    WebviewWindow,
    getAllWebviewWindows,
    getCurrentWebviewWindow,
} from "@neverwrite/runtime";
import { LogicalPosition } from "@neverwrite/runtime";
import { waitForWindowReady } from "./runtime/windowLifecycle";
import type { Tab, TabInput } from "./store/editorStore";
import type { WorkspaceDropTarget } from "./store/workspaceContracts";
import { getPathBaseName } from "./utils/path";
import { getManagedWindowChromeOptions } from "./utils/platform";
import { readSearchParam } from "./utils/safeBrowser";
import {
    safeStorageGetItem,
    safeStorageKey,
    safeStorageLength,
    safeStorageRemoveItem,
    safeStorageSetItem,
    safeStorageTrySetItem,
} from "./utils/safeStorage";
import { SETTINGS_WINDOW_TITLE } from "./utils/branding";
import { logWarn } from "./utils/runtimeLog";
import {
    collectAiSessionsForDetachedTransfer,
    prepareTabForDetachedTransfer,
} from "./detachedTabTransfer";
import type { AIChatSession } from "../features/ai/types";

const DETACHED_WINDOW_PREFIX = "note";
const DETACHED_WINDOW_STORAGE_PREFIX = "neverwrite:detached-window:";
const WINDOW_TAB_DROP_ZONE_STORAGE_PREFIX = "neverwrite:window-tab-drop-zone:";
const DETACH_WINDOW_WIDTH = 960;
const DETACH_WINDOW_HEIGHT = 720;
const DETACH_OUTSIDE_MARGIN = 30;
const DETACHED_WINDOW_CURSOR_OFFSET_X = 120;
const DETACHED_WINDOW_CURSOR_OFFSET_Y = 18;
export const ATTACH_EXTERNAL_TAB_EVENT = "neverwrite:attach-external-tab";
export const SETTINGS_OPEN_SECTION_EVENT = "neverwrite:settings-open-section";

/**
 * Purge stale localStorage entries left behind by closed/crashed windows.
 * Removes drop-zone bounds and unconsumed detached-window payloads whose
 * window label no longer exists.
 */
async function purgeStaleLocalStorageEntries() {
    try {
        const windows = await getAllWebviewWindows();
        const liveLabels = new Set(windows.map((w) => w.label));
        const keysToRemove: string[] = [];

        for (let i = 0; i < safeStorageLength(); i++) {
            const key = safeStorageKey(i);
            if (!key) continue;

            let label: string | null = null;
            if (key.startsWith(WINDOW_TAB_DROP_ZONE_STORAGE_PREFIX)) {
                label = key.slice(WINDOW_TAB_DROP_ZONE_STORAGE_PREFIX.length);
            } else if (key.startsWith(DETACHED_WINDOW_STORAGE_PREFIX)) {
                label = key.slice(DETACHED_WINDOW_STORAGE_PREFIX.length);
            }
            if (label && !liveLabels.has(label)) {
                keysToRemove.push(key);
            }
        }

        for (const key of keysToRemove) {
            safeStorageRemoveItem(key);
        }
    } catch {
        // Best-effort cleanup
    }
}

/**
 * Write to localStorage with quota-exceeded recovery: purge stale entries
 * from closed/crashed windows and retry once.
 */
async function safeSetItem(key: string, value: string) {
    if (safeStorageTrySetItem(key, value)) {
        return;
    }

    await purgeStaleLocalStorageEntries();
    if (!safeStorageSetItem(key, value)) {
        logWarn(
            "detached-window",
            "localStorage.setItem failed after cleanup",
            { key },
            { onceKey: `detached-window:${key}` },
        );
    }
}

export interface DetachedWindowPayload {
    tabs: TabInput[];
    activeTabId: string | null;
    vaultPath: string | null;
    pinnedTabIds?: string[];
    aiSessions?: AIChatSession[];
}

export interface AttachExternalTabPayload {
    tab: TabInput;
    aiSessions?: AIChatSession[];
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
    const w = readSearchParam("window");
    if (w === "note") return "note";
    if (w === "settings") return "settings";
    if (w === "ghost") return "ghost";
    return "main";
}

export function getCurrentWindowLabel() {
    return getCurrentWebviewWindow().label;
}

function resolveWindowUrl(url: string) {
    if (/^https?:\/\//i.test(url)) return url;
    if (
        window.location.protocol !== "http:" &&
        window.location.protocol !== "https:"
    ) {
        return url;
    }
    return new URL(url, window.location.origin).toString();
}

function getWebviewWindowChromeOptions(): {
    decorations?: boolean;
    titleBarStyle?: "overlay";
    hiddenTitle?: boolean;
    trafficLightPosition?: LogicalPosition;
} {
    const options = getManagedWindowChromeOptions();
    if (!options.trafficLightPosition) {
        return {
            decorations: options.decorations,
            titleBarStyle: options.titleBarStyle,
            hiddenTitle: options.hiddenTitle,
        };
    }

    return {
        decorations: options.decorations,
        titleBarStyle: options.titleBarStyle,
        hiddenTitle: options.hiddenTitle,
        trafficLightPosition: new LogicalPosition(
            options.trafficLightPosition.x,
            options.trafficLightPosition.y,
        ),
    };
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
    const raw = safeStorageGetItem(getDetachedWindowStorageKey(label));
    if (!raw) return null;
    safeStorageRemoveItem(getDetachedWindowStorageKey(label));

    try {
        const parsed = JSON.parse(raw) as DetachedWindowPayload;
        if (!Array.isArray(parsed.tabs)) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function createDetachedWindowPayload(
    tab: TabInput,
    vaultPath: string | null,
    pinnedTabIds: string[] = [],
): DetachedWindowPayload {
    const preparedTab = prepareTabForDetachedTransfer(tab);
    const aiSessions = collectAiSessionsForDetachedTransfer([tab]);
    return {
        tabs: [preparedTab],
        activeTabId: preparedTab.id,
        vaultPath,
        ...(pinnedTabIds.length > 0 ? { pinnedTabIds } : {}),
        ...(aiSessions.length > 0 ? { aiSessions } : {}),
    };
}

export function publishWindowTabDropZone(
    label: string,
    bounds: WindowTabDropZoneBounds | null,
) {
    const key = getWindowTabDropZoneStorageKey(label);
    if (!bounds) {
        safeStorageRemoveItem(key);
        return;
    }

    const stored: StoredWindowTabDropZoneBounds = {
        ...bounds,
        updatedAt: Date.now(),
    };
    void safeSetItem(key, JSON.stringify(stored));
}

function readWindowTabDropZone(label: string) {
    const raw = safeStorageGetItem(getWindowTabDropZoneStorageKey(label));
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

export function resolveDetachWindowDropTarget(
    clientX: number,
    clientY: number,
): Extract<WorkspaceDropTarget, { type: "detach-window" | "none" }> {
    return isPointerOutsideCurrentWindow(clientX, clientY)
        ? { type: "detach-window" }
        : { type: "none" };
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

interface CommitDetachedTabDropOptions {
    tab: Tab;
    screenX: number;
    screenY: number;
    vaultPath: string | null;
    windowMode: ReturnType<typeof getWindowMode>;
    currentWorkspaceTabCount: number;
    closeTab: (tabId: string, options?: { reason?: "detach" }) => void;
}

/**
 * Commit the canonical `detach-window` drop target.
 *
 * This keeps multi-window routing in the detached-window infrastructure layer
 * so workspace tab surfaces only need to decide intent, not re-implement the
 * window attach/detach workflow.
 */
export async function commitDetachedTabDrop({
    tab,
    screenX,
    screenY,
    vaultPath,
    windowMode,
    currentWorkspaceTabCount,
    closeTab,
}: CommitDetachedTabDropOptions) {
    const transferTab = prepareTabForDetachedTransfer(tab);
    const targetWindowLabel = await findWindowTabDropTarget(
        screenX,
        screenY,
        getCurrentWindowLabel(),
        vaultPath,
    );

    if (targetWindowLabel) {
        const aiSessions = collectAiSessionsForDetachedTransfer([tab]);
        await emitTo(targetWindowLabel, ATTACH_EXTERNAL_TAB_EVENT, {
            tab: transferTab,
            ...(aiSessions.length > 0 ? { aiSessions } : {}),
        } satisfies AttachExternalTabPayload);

        if (windowMode === "note" && currentWorkspaceTabCount <= 1) {
            await getCurrentWebviewWindow().close();
            return;
        }

        closeTab(tab.id, { reason: "detach" });
        return;
    }

    await openDetachedNoteWindow(
        createDetachedWindowPayload(transferTab, vaultPath),
        {
            title: transferTab.title ?? undefined,
            position: getDetachedWindowPosition(screenX, screenY),
        },
    );

    if (windowMode === "note" && currentWorkspaceTabCount <= 1) {
        await getCurrentWebviewWindow().close();
        return;
    }

    closeTab(tab.id, { reason: "detach" });
}

function settingsWindowLabel(vaultPath: string | null): string {
    if (!vaultPath) return "settings";
    // Deterministic runtime-safe label derived from the vault path
    let hash = 5381;
    for (let i = 0; i < vaultPath.length; i++) {
        hash = (((hash << 5) + hash) ^ vaultPath.charCodeAt(i)) >>> 0;
    }
    return `settings-${hash.toString(36)}`;
}

export async function openSettingsWindow(
    vaultPath: string | null = null,
    options?: {
        section?: string;
    },
) {
    const label = settingsWindowLabel(vaultPath);
    const existing = await getAllWebviewWindows();
    const settingsWin = existing.find((w) => w.label === label);
    if (settingsWin) {
        await settingsWin.show();
        await settingsWin.setFocus();
        if (options?.section) {
            await emitTo(label, SETTINGS_OPEN_SECTION_EVENT, {
                section: options.section,
            });
        }
        return;
    }
    const params = new URLSearchParams();
    params.set("window", "settings");
    if (vaultPath) {
        params.set("vault", vaultPath);
    }
    if (options?.section) {
        params.set("section", options.section);
    }
    const url = `/?${params.toString()}`;
    const win = new WebviewWindow(label, {
        url: resolveWindowUrl(url),
        title: SETTINGS_WINDOW_TITLE,
        width: 820,
        height: 560,
        minWidth: 640,
        minHeight: 480,
        center: true,
        focus: true,
        ...getWebviewWindowChromeOptions(),
    });
    await waitForWindowReady(win);
}

export async function openVaultWindow(vaultPath: string) {
    const label = `vault-${crypto.randomUUID()}`;
    const win = new WebviewWindow(label, {
        url: resolveWindowUrl(`/?vault=${encodeURIComponent(vaultPath)}`),
        title: getPathBaseName(vaultPath) || "Vault",
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        center: true,
        focus: true,
        ...getWebviewWindowChromeOptions(),
    });

    await waitForWindowReady(win);
}

export async function openDetachedNoteWindow(
    payload: DetachedWindowPayload,
    options?: {
        title?: string;
        position?: { x: number; y: number };
    },
) {
    const label = `${DETACHED_WINDOW_PREFIX}-${crypto.randomUUID()}`;
    await safeSetItem(
        getDetachedWindowStorageKey(label),
        JSON.stringify(payload),
    );

    const detachedWindow = new WebviewWindow(label, {
        url: resolveWindowUrl(getDetachedNoteWindowUrl(payload.vaultPath)),
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
        ...getWebviewWindowChromeOptions(),
    });

    try {
        await waitForWindowReady(detachedWindow);
        return detachedWindow;
    } catch (error) {
        safeStorageRemoveItem(getDetachedWindowStorageKey(label));
        throw error;
    }
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
        url: resolveWindowUrl(
            `/?window=ghost&title=${encodeURIComponent(title)}`,
        ),
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

    await waitForWindowReady(ghost);

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
