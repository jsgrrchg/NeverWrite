import { invoke } from "../../app/runtime";
import type { TerminalTab } from "../../app/store/editorStore";
import { appendTerminalRawOutput } from "../devtools/terminal/terminalRawOutput";
import {
    allocateTabSessionVersion,
    collectSessionIdsToClose,
    deleteTabSessionVersions,
} from "../devtools/terminal/terminalSessionTracking";
import {
    EMPTY_TERMINAL_SNAPSHOT,
    type TerminalErrorEventPayload,
    type TerminalOutputEventPayload,
    type TerminalSessionCreateInput,
    type TerminalSessionSnapshot,
    type TerminalSessionView,
} from "../devtools/terminal/terminalTypes";
import { create } from "zustand";

export interface WorkspaceTerminalRuntime {
    terminalId: string;
    tabId: string;
    sessionId: string | null;
    snapshot: TerminalSessionSnapshot;
    rawOutput: string;
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
        rawOutput: "",
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
        const next = await invoke<TerminalSessionSnapshot>(
            "devtools_create_terminal_session",
            {
                input: {
                    cwd: input?.cwd ?? null,
                    cols: input?.cols,
                    rows: input?.rows,
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
                        rawOutput: bufferedRaw
                            ? appendTerminalRawOutput(
                                  current.rawOutput,
                                  bufferedRaw,
                              )
                            : current.rawOutput,
                        busy: false,
                        launchError: null,
                    },
                },
            };
        });

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

            set((state) => {
                const current = state.runtimesById[terminalId];
                if (!current) return state;

                return {
                    runtimesById: {
                        ...state.runtimesById,
                        [terminalId]: {
                            ...current,
                            rawOutput: "",
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
                                rawOutput: "",
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
            set((state) => {
                const runtime = state.runtimesById[terminalId];
                if (!runtime || runtime.rawOutput.length === 0) return state;

                return {
                    runtimesById: {
                        ...state.runtimesById,
                        [terminalId]: {
                            ...runtime,
                            rawOutput: "",
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

            set((state) => {
                const runtime = getRuntimeBySessionId(
                    state.runtimesById,
                    sessionId,
                );

                if (!runtime) {
                    const existing = pendingOutputBySessionId.get(sessionId) ?? "";
                    pendingOutputBySessionId.set(
                        sessionId,
                        appendTerminalRawOutput(existing, chunk),
                    );
                    return state;
                }

                return {
                    runtimesById: {
                        ...state.runtimesById,
                        [runtime.terminalId]: {
                            ...runtime,
                            rawOutput: appendTerminalRawOutput(
                                runtime.rawOutput,
                                chunk,
                            ),
                        },
                    },
                };
            });
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
    nextTerminalSessionVersionRef.current = 1;
    useTerminalRuntimeStore.setState({ runtimesById: {} });
}

export function createTerminalSessionView(
    runtime: WorkspaceTerminalRuntime,
): TerminalSessionView {
    return {
        snapshot: runtime.snapshot,
        rawOutput: runtime.rawOutput,
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
    };
}
