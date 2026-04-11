import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getPathBaseName } from "../../app/utils/path";
import {
    safeStorageGetItem,
    safeStorageRemoveItem,
    safeStorageSetItem,
} from "../../app/utils/safeStorage";
import { isFileTab, isNoteTab, type Tab } from "../../app/store/editorStore";
import { getSessionTitle } from "../ai/sessionPresentation";
import {
    getTrackedFileReviewState,
    getTrackedFilesForSession,
} from "../ai/store/actionLogModel";
import type { AIChatSession } from "../ai/types";

const WINDOW_OPERATIONAL_STATE_PREFIX = "neverwrite:window-operational-state:";
export const WINDOW_OPERATIONAL_STATE_PUBLISH_DEBOUNCE_MS = 200;
const WINDOW_OPERATIONAL_STATE_SETTLE_BUFFER_MS = 25;

export interface WindowOperationalState {
    label: string;
    windowMode: "main" | "note";
    windowRole: "main" | "vault-window" | "detached-note";
    windowTitle: string;
    dirtyTabs: string[];
    pendingReviewSessions: string[];
    activeAgentSessions: string[];
}

export interface SensitiveUpdateItem {
    key: string;
    title: string;
    details: string[];
}

export interface SensitiveUpdateState {
    items: SensitiveUpdateItem[];
    requiresConfirmation: boolean;
}

function getOperationalStateKey(label: string) {
    return `${WINDOW_OPERATIONAL_STATE_PREFIX}${label}`;
}

export function isWindowOperationalStateStorageKey(key: string | null) {
    return (
        typeof key === "string" &&
        key.startsWith(WINDOW_OPERATIONAL_STATE_PREFIX)
    );
}

function resolveWindowRole(
    label: string,
    windowMode: "main" | "note",
): WindowOperationalState["windowRole"] {
    if (windowMode === "note") {
        return "detached-note";
    }
    if (label.startsWith("vault-")) {
        return "vault-window";
    }
    return "main";
}

function hasPendingReview(session: AIChatSession) {
    if (session.runtimeState != null && session.runtimeState !== "live") {
        return false;
    }

    return Object.values(getTrackedFilesForSession(session.actionLog)).some(
        (file) => getTrackedFileReviewState(file) === "pending",
    );
}

function isAgentSessionActive(session: AIChatSession) {
    if (session.runtimeState != null && session.runtimeState !== "live") {
        return false;
    }

    return (
        session.status === "streaming" ||
        session.status === "waiting_permission" ||
        session.status === "waiting_user_input"
    );
}

function getActiveAgentLabel(session: AIChatSession) {
    switch (session.status) {
        case "streaming":
            return "Streaming response";
        case "waiting_permission":
            return "Waiting for permission";
        case "waiting_user_input":
            return "Waiting for input";
        default:
            return session.status;
    }
}

export function buildWindowOperationalState(args: {
    label: string;
    windowMode: "main" | "note";
    vaultPath: string | null;
    tabs: readonly Tab[];
    dirtyTabIds: ReadonlySet<string>;
    sessionsById: Record<string, AIChatSession>;
}): WindowOperationalState {
    const { label, windowMode, vaultPath, tabs, dirtyTabIds, sessionsById } =
        args;
    const dirtyTabs = tabs
        .filter(
            (tab) =>
                dirtyTabIds.has(tab.id) && (isNoteTab(tab) || isFileTab(tab)),
        )
        .map((tab) => tab.title);
    const pendingReviewSessions = Object.values(sessionsById)
        .filter(hasPendingReview)
        .map((session) => getSessionTitle(session));
    const activeAgentSessions = Object.values(sessionsById)
        .filter(isAgentSessionActive)
        .map(
            (session) =>
                `${getSessionTitle(session)} · ${getActiveAgentLabel(session)}`,
        );
    const windowTitle =
        tabs.find((tab) => dirtyTabIds.has(tab.id))?.title ||
        tabs[0]?.title ||
        getPathBaseName(vaultPath ?? "") ||
        "Window";

    return {
        label,
        windowMode,
        windowRole: resolveWindowRole(label, windowMode),
        windowTitle,
        dirtyTabs,
        pendingReviewSessions,
        activeAgentSessions,
    };
}

export function writeWindowOperationalState(
    label: string,
    state: WindowOperationalState | null,
) {
    const key = getOperationalStateKey(label);
    if (!state) {
        if (safeStorageGetItem(key) === null) {
            return false;
        }
        safeStorageRemoveItem(key);
        return true;
    }

    // Avoid rewriting and rebroadcasting identical operational snapshots.
    const serializedState = JSON.stringify(state);
    if (safeStorageGetItem(key) === serializedState) {
        return false;
    }

    safeStorageSetItem(key, serializedState);
    return true;
}

export function readWindowOperationalState(label: string) {
    const raw = safeStorageGetItem(getOperationalStateKey(label));
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as WindowOperationalState;
        if (
            typeof parsed.label !== "string" ||
            (parsed.windowMode !== "main" && parsed.windowMode !== "note") ||
            !Array.isArray(parsed.dirtyTabs) ||
            !Array.isArray(parsed.pendingReviewSessions) ||
            !Array.isArray(parsed.activeAgentSessions)
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export async function listLiveWindowOperationalStates() {
    const windows = await getAllWebviewWindows();
    if (!Array.isArray(windows)) {
        return [];
    }

    return windows
        .map((window) => readWindowOperationalState(window.label))
        .filter((state): state is WindowOperationalState => state !== null);
}

export async function readSensitiveUpdateState() {
    return collectSensitiveUpdateState(await listLiveWindowOperationalStates());
}

function waitForOperationalStateSettle(ms: number) {
    return new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

export async function readSettledSensitiveUpdateState() {
    const next = await readSensitiveUpdateState();
    if (next.requiresConfirmation) {
        return next;
    }

    await waitForOperationalStateSettle(
        WINDOW_OPERATIONAL_STATE_PUBLISH_DEBOUNCE_MS +
            WINDOW_OPERATIONAL_STATE_SETTLE_BUFFER_MS,
    );
    return readSensitiveUpdateState();
}

export function collectSensitiveUpdateState(
    states: readonly WindowOperationalState[],
): SensitiveUpdateState {
    const items: SensitiveUpdateItem[] = [];

    const dirtyTabs = states.flatMap((state) =>
        state.dirtyTabs.map((title) => `${state.windowTitle}: ${title}`),
    );
    if (dirtyTabs.length > 0) {
        items.push({
            key: "dirty-tabs",
            title: "Unsaved editor tabs",
            details: dirtyTabs,
        });
    }

    const pendingReviewSessions = states.flatMap(
        (state) => state.pendingReviewSessions,
    );
    if (pendingReviewSessions.length > 0) {
        items.push({
            key: "pending-review",
            title: "Pending inline review or agent changes",
            details: pendingReviewSessions,
        });
    }

    const activeAgentSessions = states.flatMap(
        (state) => state.activeAgentSessions,
    );
    if (activeAgentSessions.length > 0) {
        items.push({
            key: "active-sessions",
            title: "Active agent sessions",
            details: activeAgentSessions,
        });
    }

    const separateOperationalWindows = states
        .filter((state) => state.windowRole !== "main")
        .map((state) =>
            state.windowRole === "detached-note"
                ? `${state.windowTitle} is open in a detached note window.`
                : `${state.windowTitle} is open in a separate vault window.`,
        );
    if (separateOperationalWindows.length > 0) {
        items.push({
            key: "separate-windows",
            title: "Separate operational windows are open",
            details: separateOperationalWindows,
        });
    }

    return {
        items,
        requiresConfirmation: items.length > 0,
    };
}
