import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import type { DetachedWindowPayload } from "./detachedWindows";
import type { Tab } from "./store/editorStore";

const WINDOW_SESSION_DESCRIPTOR_PREFIX = "vaultai:window-session:";
const WINDOW_SESSION_SNAPSHOT_KEY = "vaultai:window-session-snapshot";

export interface PersistedVaultWindow {
    label: string;
    kind: "vault";
    vaultPath: string;
}

export interface PersistedNoteWindow {
    label: string;
    kind: "note";
    payload: DetachedWindowPayload;
    title: string;
}

export type PersistedWindowSessionEntry =
    | PersistedVaultWindow
    | PersistedNoteWindow;

function getWindowSessionDescriptorKey(label: string) {
    return `${WINDOW_SESSION_DESCRIPTOR_PREFIX}${label}`;
}

function isDetachedWindowPayload(
    value: unknown,
): value is DetachedWindowPayload {
    if (!value || typeof value !== "object") return false;
    const payload = value as Record<string, unknown>;
    return (
        Array.isArray(payload.tabs) &&
        (typeof payload.activeTabId === "string" ||
            payload.activeTabId === null) &&
        (typeof payload.vaultPath === "string" || payload.vaultPath === null)
    );
}

export function buildWindowSessionEntry(args: {
    label: string;
    windowMode: "main" | "note" | "settings";
    vaultPath: string | null;
    tabs: Tab[];
    activeTabId: string | null;
}): PersistedWindowSessionEntry | null {
    const { label, windowMode, vaultPath, tabs, activeTabId } = args;

    if (windowMode === "settings") {
        return null;
    }

    if (windowMode === "note") {
        if (tabs.length === 0) return null;
        const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
        return {
            label,
            kind: "note",
            payload: {
                tabs,
                activeTabId,
                vaultPath,
            },
            title: activeTab?.title ?? "Note",
        };
    }

    if (!vaultPath) {
        return null;
    }

    return {
        label,
        kind: "vault",
        vaultPath,
    };
}

export function writeWindowSessionEntry(
    label: string,
    entry: PersistedWindowSessionEntry | null,
) {
    const key = getWindowSessionDescriptorKey(label);
    if (!entry) {
        localStorage.removeItem(key);
        return;
    }
    try {
        localStorage.setItem(key, JSON.stringify(entry));
    } catch (error) {
        console.warn("Failed to write window session entry:", error);
    }
}

export function readWindowSessionEntry(label: string) {
    const raw = localStorage.getItem(getWindowSessionDescriptorKey(label));
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as Partial<PersistedWindowSessionEntry>;
        if (
            parsed.kind === "vault" &&
            typeof parsed.label === "string" &&
            typeof parsed.vaultPath === "string"
        ) {
            return parsed as PersistedVaultWindow;
        }

        if (
            parsed.kind === "note" &&
            typeof parsed.label === "string" &&
            typeof parsed.title === "string" &&
            isDetachedWindowPayload(parsed.payload)
        ) {
            return parsed as PersistedNoteWindow;
        }
    } catch {
        return null;
    }

    return null;
}

export function readWindowSessionSnapshot() {
    const raw = localStorage.getItem(WINDOW_SESSION_SNAPSHOT_KEY);
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw) as unknown[];
        if (!Array.isArray(parsed)) return [];

        return parsed
            .map((entry) => {
                const label = typeof entry === "string" ? entry : null;
                return label ? (readWindowSessionEntry(label) ?? null) : null;
            })
            .filter(
                (entry): entry is PersistedWindowSessionEntry => entry !== null,
            );
    } catch {
        return [];
    }
}

function sortWindowSessionEntries(entries: PersistedWindowSessionEntry[]) {
    return [...entries].sort((left, right) => {
        const leftRank =
            left.label === "main" ? 0 : left.kind === "vault" ? 1 : 2;
        const rightRank =
            right.label === "main" ? 0 : right.kind === "vault" ? 1 : 2;

        if (leftRank !== rightRank) {
            return leftRank - rightRank;
        }

        if (left.kind === "vault" && right.kind === "vault") {
            return left.vaultPath.localeCompare(right.vaultPath);
        }

        return left.label.localeCompare(right.label);
    });
}

export async function refreshWindowSessionSnapshot() {
    const windows = await getAllWebviewWindows();
    const openLabels = new Set(
        windows
            .map((window) => window.label)
            .filter((label) => !label.startsWith("ghost-")),
    );

    const entries = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
    )
        .filter(
            (key): key is string =>
                typeof key === "string" &&
                key.startsWith(WINDOW_SESSION_DESCRIPTOR_PREFIX),
        )
        .map((key) => key.slice(WINDOW_SESSION_DESCRIPTOR_PREFIX.length))
        .filter((label) => openLabels.has(label))
        .map((label) => readWindowSessionEntry(label))
        .filter(
            (entry): entry is PersistedWindowSessionEntry => entry !== null,
        );

    try {
        localStorage.setItem(
            WINDOW_SESSION_SNAPSHOT_KEY,
            JSON.stringify(
                sortWindowSessionEntries(entries).map((entry) => entry.label),
            ),
        );
    } catch (error) {
        console.warn("Failed to write window session snapshot:", error);
    }

    return entries;
}

export async function restoreWindowSession(args: {
    openPrimaryVault: (vaultPath: string) => Promise<void>;
    restorePrimaryVaultSession: () => Promise<void>;
    openVaultWindow: (vaultPath: string) => Promise<void>;
    openDetachedNoteWindow: (
        payload: DetachedWindowPayload,
        options?: { title?: string },
    ) => Promise<unknown>;
}) {
    const entries = readWindowSessionSnapshot();
    if (entries.length === 0) return false;

    const primaryVault =
        entries.find(
            (entry) => entry.label === "main" && entry.kind === "vault",
        ) ?? entries.find((entry) => entry.kind === "vault");

    if (primaryVault?.kind === "vault") {
        await args.openPrimaryVault(primaryVault.vaultPath);
        await args.restorePrimaryVaultSession();
    }

    for (const entry of entries) {
        if (entry === primaryVault) continue;

        if (entry.kind === "vault") {
            await args.openVaultWindow(entry.vaultPath);
            continue;
        }

        await args.openDetachedNoteWindow(entry.payload, {
            title: entry.title,
        });
    }

    return true;
}
