import { invoke } from "../../app/runtime";
import type { TerminalTab } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import {
    safeStorageGetItem,
    safeStorageRemoveItem,
    safeStorageTrySetItem,
} from "../../app/utils/safeStorage";
import {
    allocateTabSessionVersion,
    collectSessionIdsToClose,
    deleteTabSessionVersions,
} from "./terminalSessionTracking";
import {
    EMPTY_TERMINAL_SNAPSHOT,
    type TerminalErrorEventPayload,
    type TerminalOutputCommand,
    type TerminalOutputEventPayload,
    type TerminalSessionCreateInput,
    type TerminalSessionSnapshot,
    type TerminalSessionView,
} from "./terminalTypes";
import { create } from "zustand";

export interface WorkspaceTerminalRuntime {
    terminalId: string;
    tabId: string;
    sessionId: string | null;
    snapshot: TerminalSessionSnapshot;
    // Whether any output has been produced this session. Screen content itself
    // lives in the xterm instance — this only drives empty-state UI.
    hasOutput: boolean;
    busy: boolean;
    launchError: string | null;
}

interface WorkspaceTerminalRuntimeStoreState {
    runtimesById: Record<string, WorkspaceTerminalRuntime>;
}

interface WorkspaceTerminalRuntimeStoreActions {
    ensureTerminal: (tab: TerminalTab) => void;
    writeInput: (terminalId: string, input: string) => Promise<void>;
    resize: (terminalId: string, cols: number, rows: number) => Promise<void>;
    restart: (terminalId: string) => Promise<void>;
    clear: (terminalId: string) => void;
    closeTerminal: (terminalId: string) => Promise<void>;
    closeMissingTerminals: (liveTerminalIds: Iterable<string>) => void;
    handleTerminalOutput: (payload: TerminalOutputEventPayload) => void;
    handleTerminalStarted: (snapshot: TerminalSessionSnapshot) => void;
    handleTerminalExited: (snapshot: TerminalSessionSnapshot) => void;
    handleTerminalError: (payload: TerminalErrorEventPayload) => void;
}

export type WorkspaceTerminalRuntimeStore =
    WorkspaceTerminalRuntimeStoreState & WorkspaceTerminalRuntimeStoreActions;

const pendingOutputBySessionId = new Map<string, string>();
const terminalSessionVersions = new Map<string, number>();
const retiredSessionIds = new Map<string, true>();
const pendingResizeByTerminalId = new Map<
    string,
    { cols: number; rows: number }
>();
const suppressedOutputSessionIds = new Map<string, true>();
const nextTerminalSessionVersionRef = { current: 1 };

// --- Live output delivery -------------------------------------------------
// Output is piped straight to the mounted xterm viewport via per-terminal
// command channels rather than accumulated in React state and diffed. A small
// backlog buffers commands emitted before the viewport's first subscriber
// attaches (the brief window between session start and mount); it is flushed on
// subscribe. The backlog is bounded so a never-mounted terminal can't grow it
// without limit.
const MAX_BOOTSTRAP_BACKLOG_CHARS = 256_000;

interface TerminalOutputChannel {
    listeners: Set<(command: TerminalOutputCommand) => void>;
    backlog: TerminalOutputCommand[];
    backlogChars: number;
}

const outputChannelsByTerminalId = new Map<string, TerminalOutputChannel>();

function getOutputChannel(terminalId: string): TerminalOutputChannel {
    let channel = outputChannelsByTerminalId.get(terminalId);
    if (!channel) {
        channel = { listeners: new Set(), backlog: [], backlogChars: 0 };
        outputChannelsByTerminalId.set(terminalId, channel);
    }
    return channel;
}

function emitOutputCommand(terminalId: string, command: TerminalOutputCommand) {
    const channel = getOutputChannel(terminalId);
    if (channel.listeners.size === 0) {
        channel.backlog.push(command);
        if (command.type === "write") {
            channel.backlogChars += command.data.length;
        }
        // Drop oldest commands once the bootstrap window overflows. This only
        // bites if a terminal produces output but is never mounted.
        while (
            channel.backlogChars > MAX_BOOTSTRAP_BACKLOG_CHARS &&
            channel.backlog.length > 1
        ) {
            const dropped = channel.backlog.shift();
            if (dropped?.type === "write") {
                channel.backlogChars -= dropped.data.length;
            }
        }
        return;
    }
    for (const listener of channel.listeners) {
        listener(command);
    }
}

function subscribeOutputChannel(
    terminalId: string,
    listener: (command: TerminalOutputCommand) => void,
): () => void {
    const channel = getOutputChannel(terminalId);
    // Flush any commands buffered before the first subscriber attached.
    if (channel.listeners.size === 0 && channel.backlog.length > 0) {
        const pending = channel.backlog;
        channel.backlog = [];
        channel.backlogChars = 0;
        for (const command of pending) {
            listener(command);
        }
    }
    channel.listeners.add(listener);
    return () => {
        channel.listeners.delete(listener);
    };
}

function resetOutputChannel(terminalId: string) {
    const channel = outputChannelsByTerminalId.get(terminalId);
    if (channel) {
        channel.backlog = [];
        channel.backlogChars = 0;
    }
}

// --- Reattach snapshots ---------------------------------------------------
// A serialized xterm buffer per terminal, written back on mount to restore
// screen content. Kept in memory for fast in-session remounts (pane reshuffle)
// and mirrored to persistent storage so content survives a full reload. The
// terminalId is stable across reloads (it is persisted with the tab).
const REPLAY_SNAPSHOT_STORAGE_PREFIX = "neverwrite.terminal.replay:";
const replaySnapshotsByTerminalId = new Map<string, string>();

function replaySnapshotStorageKey(terminalId: string) {
    return `${REPLAY_SNAPSHOT_STORAGE_PREFIX}${terminalId}`;
}

function getReplaySnapshot(terminalId: string): string | null {
    const inMemory = replaySnapshotsByTerminalId.get(terminalId);
    if (inMemory !== undefined) {
        return inMemory;
    }
    return safeStorageGetItem(replaySnapshotStorageKey(terminalId));
}

function saveReplaySnapshot(terminalId: string, serialized: string) {
    if (!serialized) {
        clearReplaySnapshot(terminalId);
        return;
    }
    replaySnapshotsByTerminalId.set(terminalId, serialized);
    safeStorageTrySetItem(replaySnapshotStorageKey(terminalId), serialized);
}

function clearReplaySnapshot(terminalId: string) {
    replaySnapshotsByTerminalId.delete(terminalId);
    safeStorageRemoveItem(replaySnapshotStorageKey(terminalId));
}

function createRuntimeSnapshot(cwd: string | null): TerminalSessionSnapshot {
    return {
        ...EMPTY_TERMINAL_SNAPSHOT,
        cwd: cwd ?? "",
        status: "starting",
        errorMessage: null,
    };
}

function createInitialRuntime(tab: TerminalTab): WorkspaceTerminalRuntime {
    return {
        terminalId: tab.terminalId,
        tabId: tab.id,
        sessionId: null,
        snapshot: createRuntimeSnapshot(tab.cwd),
        hasOutput: false,
        busy: true,
        launchError: null,
    };
}

function getRuntimeBySessionId(
    runtimesById: Record<string, WorkspaceTerminalRuntime>,
    sessionId: string,
) {
    return (
        Object.values(runtimesById).find(
            (runtime) => runtime.sessionId === sessionId,
        ) ?? null
    );
}

function normalizeError(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : String(error ?? fallback);
}

async function closeSessionIds(sessionIds: string[]) {
    await Promise.all(
        sessionIds.map((sessionId) =>
            Promise.resolve(
                invoke("devtools_close_terminal_session", { sessionId }),
            ).catch(() => undefined),
        ),
    );
}

function collectTrackedSessionIdsToClose(sessionIds: string[]) {
    return collectSessionIdsToClose(
        sessionIds,
        retiredSessionIds,
        pendingOutputBySessionId,
    );
}

function retireAndCloseSessionIds(sessionIds: string[]) {
    const nextSessionIds = collectTrackedSessionIdsToClose(sessionIds);
    for (const sessionId of nextSessionIds) {
        suppressedOutputSessionIds.delete(sessionId);
    }
    if (nextSessionIds.length > 0) {
        void closeSessionIds(nextSessionIds);
    }
}

function allocateTerminalSessionVersion(terminalId: string) {
    return allocateTabSessionVersion(
        terminalSessionVersions,
        nextTerminalSessionVersionRef,
        terminalId,
    );
}

async function createSessionForTerminal(
    terminalId: string,
    input?: TerminalSessionCreateInput,
) {
    const requestVersion = allocateTerminalSessionVersion(terminalId);

    try {
        const { claudeCodeOptimized } = useSettingsStore.getState();
        const extraEnv: Record<string, string> = {
            ...(claudeCodeOptimized && { CLAUDE_CODE_NO_FLICKER: "1" }),
            ...input?.extraEnv,
        };
        const next = await invoke<TerminalSessionSnapshot>(
            "devtools_create_terminal_session",
            {
                input: {
                    cwd: input?.cwd ?? null,
                    cols: input?.cols,
                    rows: input?.rows,
                    extraEnv,
                },
            },
        );

        const currentState = useTerminalRuntimeStore.getState();
        const runtime = currentState.runtimesById[terminalId];

        if (
            !runtime ||
            terminalSessionVersions.get(terminalId) !== requestVersion
        ) {
            retireAndCloseSessionIds([next.sessionId]);
            return next;
        }

        const bufferedRaw = pendingOutputBySessionId.get(next.sessionId) ?? "";
        pendingOutputBySessionId.delete(next.sessionId);

        pendingResizeByTerminalId.delete(terminalId);
        useTerminalRuntimeStore.setState((state) => {
            const current = state.runtimesById[terminalId];
            if (!current) return state;

            return {
                runtimesById: {
                    ...state.runtimesById,
                    [terminalId]: {
                        ...current,
                        sessionId: next.sessionId,
                        snapshot: next,
                        hasOutput: current.hasOutput || bufferedRaw.length > 0,
                        busy: false,
                        launchError: null,
                    },
                },
            };
        });

        // Output that raced ahead of the runtime gaining its sessionId is piped
        // through now, in order, ahead of any live chunks.
        if (bufferedRaw.length > 0) {
            emitOutputCommand(terminalId, { type: "write", data: bufferedRaw });
        }

        return next;
    } catch (error) {
        useTerminalRuntimeStore.setState((state) => {
            const current = state.runtimesById[terminalId];
            if (!current) return state;

            const message = normalizeError(error, "Terminal session failed");
            return {
                runtimesById: {
                    ...state.runtimesById,
                    [terminalId]: {
                        ...current,
                        busy: false,
                        launchError: message,
                        snapshot: {
                            ...current.snapshot,
                            status: "error",
                            errorMessage: message,
                        },
                    },
                },
            };
        });
        return null;
    }
}

function updateRuntimeBySessionId(
    sessionId: string,
    updater: (
        runtime: WorkspaceTerminalRuntime,
    ) => WorkspaceTerminalRuntime,
) {
    useTerminalRuntimeStore.setState((state) => {
        const runtime = getRuntimeBySessionId(state.runtimesById, sessionId);
        if (!runtime) return state;

        return {
            runtimesById: {
                ...state.runtimesById,
                [runtime.terminalId]: updater(runtime),
            },
        };
    });
}

export const useTerminalRuntimeStore = create<WorkspaceTerminalRuntimeStore>(
    (set, get) => ({
        runtimesById: {},

        ensureTerminal: (tab) => {
            const existing = get().runtimesById[tab.terminalId];

            if (!existing) {
                const runtime = createInitialRuntime(tab);
                set((state) => ({
                    runtimesById: {
                        ...state.runtimesById,
                        [tab.terminalId]: runtime,
                    },
                }));
                void createSessionForTerminal(tab.terminalId, {
                    cwd: tab.cwd,
                    cols: runtime.snapshot.cols,
                    rows: runtime.snapshot.rows,
                });
                return;
            }

            if (existing.tabId !== tab.id) {
                set((state) => ({
                    runtimesById: {
                        ...state.runtimesById,
                        [tab.terminalId]: {
                            ...existing,
                            tabId: tab.id,
                        },
                    },
                }));
            }

            if (!existing.sessionId && !existing.busy) {
                set((state) => ({
                    runtimesById: {
                        ...state.runtimesById,
                        [tab.terminalId]: {
                            ...existing,
                            tabId: tab.id,
                            busy: true,
                            launchError: null,
                            snapshot: {
                                ...existing.snapshot,
                                cwd: tab.cwd ?? existing.snapshot.cwd,
                                status: "starting",
                                errorMessage: null,
                                exitCode: null,
                            },
                        },
                    },
                }));
                void createSessionForTerminal(tab.terminalId, {
                    cwd: tab.cwd,
                    cols: existing.snapshot.cols,
                    rows: existing.snapshot.rows,
                });
            }
        },

        writeInput: async (terminalId, input) => {
            if (!input) return;

            const runtime = get().runtimesById[terminalId];
            if (!runtime?.sessionId) return;

            await invoke("devtools_write_terminal_session", {
                input: {
                    sessionId: runtime.sessionId,
                    data: input,
                },
            });
        },

        resize: async (terminalId, cols, rows) => {
            if (cols < 1 || rows < 1) return;

            const runtime = get().runtimesById[terminalId];
            if (!runtime?.sessionId) return;
            if (runtime.snapshot.cols === cols && runtime.snapshot.rows === rows) {
                return;
            }

            const pendingResize = pendingResizeByTerminalId.get(terminalId);
            if (
                pendingResize &&
                pendingResize.cols === cols &&
                pendingResize.rows === rows
            ) {
                return;
            }

            pendingResizeByTerminalId.set(terminalId, { cols, rows });
            try {
                const next = await invoke<TerminalSessionSnapshot>(
                    "devtools_resize_terminal_session",
                    {
                        input: {
                            sessionId: runtime.sessionId,
                            cols,
                            rows,
                        },
                    },
                );

                const current = get().runtimesById[terminalId];
                if (!current || current.sessionId !== runtime.sessionId) return;
                pendingResizeByTerminalId.delete(terminalId);
                set((state) => ({
                    runtimesById: {
                        ...state.runtimesById,
                        [terminalId]: {
                            ...current,
                            snapshot: {
                                ...current.snapshot,
                                cols: next.cols,
                                rows: next.rows,
                            },
                        },
                    },
                }));
            } catch (error) {
                const pending = pendingResizeByTerminalId.get(terminalId);
                if (pending?.cols === cols && pending.rows === rows) {
                    pendingResizeByTerminalId.delete(terminalId);
                }
                throw error;
            }
        },

        restart: async (terminalId) => {
            const runtime = get().runtimesById[terminalId];
            if (!runtime) return;

            const requestVersion = allocateTerminalSessionVersion(terminalId);
            const previousSessionId = runtime.sessionId;
            if (previousSessionId) {
                suppressedOutputSessionIds.set(previousSessionId, true);
            }
            pendingResizeByTerminalId.delete(terminalId);
            // The previous session's screen is gone — wipe xterm, drop any
            // buffered output, and discard the reattach snapshot.
            resetOutputChannel(terminalId);
            clearReplaySnapshot(terminalId);
            emitOutputCommand(terminalId, { type: "clear" });

            set((state) => {
                const current = state.runtimesById[terminalId];
                if (!current) return state;

                return {
                    runtimesById: {
                        ...state.runtimesById,
                        [terminalId]: {
                            ...current,
                            hasOutput: false,
                            busy: true,
                            launchError: null,
                            snapshot: {
                                ...current.snapshot,
                                status: "starting",
                                errorMessage: null,
                                exitCode: null,
                            },
                        },
                    },
                };
            });

            if (!previousSessionId) {
                await createSessionForTerminal(terminalId, {
                    cwd: runtime.snapshot.cwd,
                    cols: runtime.snapshot.cols,
                    rows: runtime.snapshot.rows,
                });
                return;
            }

            try {
                const next = await invoke<TerminalSessionSnapshot>(
                    "devtools_restart_terminal_session",
                    { sessionId: previousSessionId },
                );

                suppressedOutputSessionIds.delete(previousSessionId);
                if (terminalSessionVersions.get(terminalId) !== requestVersion) {
                    retireAndCloseSessionIds([next.sessionId]);
                    return;
                }

                set((state) => {
                    const current = state.runtimesById[terminalId];
                    if (!current) return state;

                    return {
                        runtimesById: {
                            ...state.runtimesById,
                            [terminalId]: {
                                ...current,
                                sessionId: next.sessionId,
                                snapshot: next,
                                hasOutput: false,
                                busy: false,
                                launchError: null,
                            },
                        },
                    };
                });
            } catch (error) {
                suppressedOutputSessionIds.delete(previousSessionId);
                const message = normalizeError(error, "Terminal restart failed");
                set((state) => {
                    const current = state.runtimesById[terminalId];
                    if (!current) return state;

                    return {
                        runtimesById: {
                            ...state.runtimesById,
                            [terminalId]: {
                                ...current,
                                busy: false,
                                launchError: message,
                                snapshot: {
                                    ...current.snapshot,
                                    status: "error",
                                    errorMessage: message,
                                },
                            },
                        },
                    };
                });
            }
        },

        clear: (terminalId) => {
            resetOutputChannel(terminalId);
            clearReplaySnapshot(terminalId);
            emitOutputCommand(terminalId, { type: "clear" });
            set((state) => {
                const runtime = state.runtimesById[terminalId];
                if (!runtime || !runtime.hasOutput) return state;

                return {
                    runtimesById: {
                        ...state.runtimesById,
                        [terminalId]: {
                            ...runtime,
                            hasOutput: false,
                        },
                    },
                };
            });
        },

        closeTerminal: async (terminalId) => {
            const runtime = get().runtimesById[terminalId];
            if (!runtime) return;

            allocateTerminalSessionVersion(terminalId);
            deleteTabSessionVersions(terminalSessionVersions, [terminalId]);
            pendingResizeByTerminalId.delete(terminalId);
            outputChannelsByTerminalId.delete(terminalId);
            clearReplaySnapshot(terminalId);

            set((state) => {
                const { [terminalId]: _removed, ...remaining } =
                    state.runtimesById;
                void _removed;
                return { runtimesById: remaining };
            });

            if (runtime.sessionId) {
                const sessionIds = collectTrackedSessionIdsToClose([
                    runtime.sessionId,
                ]);
                for (const sessionId of sessionIds) {
                    suppressedOutputSessionIds.delete(sessionId);
                }
                await closeSessionIds(sessionIds);
            }
        },

        closeMissingTerminals: (liveTerminalIds) => {
            const live = new Set(liveTerminalIds);
            const missingTerminalIds = Object.keys(get().runtimesById).filter(
                (terminalId) => !live.has(terminalId),
            );

            for (const terminalId of missingTerminalIds) {
                void get().closeTerminal(terminalId);
            }
        },

        handleTerminalOutput: ({ sessionId, chunk }) => {
            if (!sessionId || !chunk) return;
            if (retiredSessionIds.has(sessionId)) return;
            if (suppressedOutputSessionIds.has(sessionId)) return;

            const runtime = getRuntimeBySessionId(get().runtimesById, sessionId);

            if (!runtime) {
                // Output arrived before the runtime learned its sessionId. Hold
                // it briefly; createSessionForTerminal replays it on attach.
                const existing = pendingOutputBySessionId.get(sessionId) ?? "";
                pendingOutputBySessionId.set(sessionId, existing + chunk);
                return;
            }

            // Pipe straight to the mounted viewport. No accumulation in state.
            emitOutputCommand(runtime.terminalId, { type: "write", data: chunk });

            // Flip the empty-state flag exactly once, on the first chunk.
            if (!runtime.hasOutput) {
                set((state) => {
                    const current = state.runtimesById[runtime.terminalId];
                    if (!current || current.hasOutput) return state;
                    return {
                        runtimesById: {
                            ...state.runtimesById,
                            [runtime.terminalId]: {
                                ...current,
                                hasOutput: true,
                            },
                        },
                    };
                });
            }
        },

        handleTerminalStarted: (snapshot) => {
            suppressedOutputSessionIds.delete(snapshot.sessionId);
            updateRuntimeBySessionId(snapshot.sessionId, (runtime) => ({
                ...runtime,
                snapshot,
                busy: false,
                launchError: null,
            }));
        },

        handleTerminalExited: (snapshot) => {
            suppressedOutputSessionIds.delete(snapshot.sessionId);
            updateRuntimeBySessionId(snapshot.sessionId, (runtime) => ({
                ...runtime,
                snapshot,
                busy: false,
            }));
        },

        handleTerminalError: ({ sessionId, message }) => {
            suppressedOutputSessionIds.delete(sessionId);
            updateRuntimeBySessionId(sessionId, (runtime) => ({
                ...runtime,
                busy: false,
                launchError: message,
                snapshot: {
                    ...runtime.snapshot,
                    status: "error",
                    errorMessage: message,
                },
            }));
        },
    }),
);

export function selectWorkspaceTerminalRuntime(
    terminalId: string | null | undefined,
) {
    return terminalId
        ? (useTerminalRuntimeStore.getState().runtimesById[terminalId] ?? null)
        : null;
}

export function resetTerminalRuntimeStoreForTests() {
    pendingOutputBySessionId.clear();
    terminalSessionVersions.clear();
    retiredSessionIds.clear();
    pendingResizeByTerminalId.clear();
    suppressedOutputSessionIds.clear();
    outputChannelsByTerminalId.clear();
    replaySnapshotsByTerminalId.clear();
    nextTerminalSessionVersionRef.current = 1;
    useTerminalRuntimeStore.setState({ runtimesById: {} });
}

export function createTerminalSessionView(
    runtime: WorkspaceTerminalRuntime,
): TerminalSessionView {
    return {
        snapshot: runtime.snapshot,
        hasOutput: runtime.hasOutput,
        busy: runtime.busy,
        writeInput: (input: string) =>
            useTerminalRuntimeStore
                .getState()
                .writeInput(runtime.terminalId, input),
        resize: (cols: number, rows: number) =>
            useTerminalRuntimeStore
                .getState()
                .resize(runtime.terminalId, cols, rows),
        restart: () =>
            useTerminalRuntimeStore.getState().restart(runtime.terminalId),
        clearViewport: () =>
            useTerminalRuntimeStore.getState().clear(runtime.terminalId),
        subscribeOutput: (listener) =>
            subscribeOutputChannel(runtime.terminalId, listener),
        getReplaySnapshot: () => getReplaySnapshot(runtime.terminalId),
        saveReplaySnapshot: (serialized: string) =>
            saveReplaySnapshot(runtime.terminalId, serialized),
    };
}
