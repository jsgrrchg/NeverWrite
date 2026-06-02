import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    aiCloseAuthTerminalSession,
    aiStartAuthTerminalSession,
    aiWriteAuthTerminalSession,
    aiResizeAuthTerminalSession,
    listenToAiAuthTerminalError,
    listenToAiAuthTerminalExited,
    listenToAiAuthTerminalOutput,
    listenToAiAuthTerminalStarted,
} from "../api";
import type { AIAuthTerminalSessionSnapshot } from "../types";
import { appendTerminalRawOutput } from "../../terminal/terminalRawOutput";
import { TerminalViewport } from "../../terminal/TerminalViewport";
import {
    EMPTY_TERMINAL_SNAPSHOT,
    type TerminalOutputCommand,
    type TerminalSessionView,
} from "../../terminal/terminalTypes";
import { APP_BRAND_NAME } from "../../../app/utils/branding";

interface AIAuthTerminalModalProps {
    open: boolean;
    runtimeId: string;
    methodId?: string;
    runtimeName: string;
    vaultPath: string | null;
    customBinaryPath?: string;
    onClose: () => void;
    onRefreshSetup: (runtimeId: string) => Promise<void>;
}

function buildInitialSnapshot(
    runtimeId: string,
    runtimeName: string,
    vaultPath: string | null,
): AIAuthTerminalSessionSnapshot {
    return {
        sessionId: EMPTY_TERMINAL_SNAPSHOT.sessionId,
        program: EMPTY_TERMINAL_SNAPSHOT.program,
        runtimeId,
        displayName: `${runtimeName} sign-in`,
        cwd: vaultPath ?? "",
        cols: EMPTY_TERMINAL_SNAPSHOT.cols,
        rows: EMPTY_TERMINAL_SNAPSHOT.rows,
        buffer: "",
        status: "starting",
        exitCode: EMPTY_TERMINAL_SNAPSHOT.exitCode,
        errorMessage: EMPTY_TERMINAL_SNAPSHOT.errorMessage,
    };
}

function getErrorMessage(error: unknown) {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    return String(error);
}

function getRunningStatusLabel(runtimeName: string) {
    return `Waiting for ${runtimeName} sign-in`;
}

function authTerminalOutputIndicatesSuccess(runtimeId: string, output: string) {
    if (runtimeId === "gemini-acp") {
        return (
            output.includes("Authentication succeeded") ||
            output.includes("successfully signed in with Google")
        );
    }

    if (runtimeId === "grok-acp" || runtimeId === "opencode-acp") {
        const normalized = output.toLowerCase();
        return (
            normalized.includes("authentication successful") ||
            normalized.includes("login successful") ||
            normalized.includes("successfully authenticated") ||
            normalized.includes("successfully logged in")
        );
    }

    return false;
}

export function AIAuthTerminalModal({
    open,
    runtimeId,
    methodId,
    runtimeName,
    vaultPath,
    customBinaryPath,
    onClose,
    onRefreshSetup,
}: AIAuthTerminalModalProps) {
    const sessionIdRef = useRef<string | null>(null);
    const [snapshot, setSnapshot] = useState<AIAuthTerminalSessionSnapshot>(
        buildInitialSnapshot(runtimeId, runtimeName, vaultPath),
    );
    const [rawOutput, setRawOutput] = useState("");
    const [busy, setBusy] = useState(false);
    const onRefreshSetupRef = useRef(onRefreshSetup);
    // Local output channel feeding the viewport (it pipes commands straight to
    // xterm). rawOutput state is kept separately, only for auth-success scanning.
    const outputListenersRef = useRef(
        new Set<(command: TerminalOutputCommand) => void>(),
    );
    const outputBacklogRef = useRef<TerminalOutputCommand[]>([]);
    const replaySnapshotRef = useRef<string | null>(null);

    const emitOutputCommand = useCallback((command: TerminalOutputCommand) => {
        const listeners = outputListenersRef.current;
        if (listeners.size === 0) {
            outputBacklogRef.current.push(command);
            return;
        }
        for (const listener of listeners) {
            listener(command);
        }
    }, []);

    // Reset the viewport screen and feed it an initial buffer (e.g. on (re)start).
    const resetOutputWithBuffer = useCallback(
        (buffer: string) => {
            replaySnapshotRef.current = null;
            outputBacklogRef.current = [];
            emitOutputCommand({ type: "clear" });
            if (buffer) {
                emitOutputCommand({ type: "write", data: buffer });
            }
        },
        [emitOutputCommand],
    );

    useEffect(() => {
        onRefreshSetupRef.current = onRefreshSetup;
    }, [onRefreshSetup]);

    useEffect(() => {
        if (!open) return;
        setSnapshot(buildInitialSnapshot(runtimeId, runtimeName, vaultPath));
        setRawOutput("");
        setBusy(false);
    }, [open, runtimeId, runtimeName, vaultPath]);

    useEffect(() => {
        if (!open) return;

        let disposed = false;
        const unsubs: Array<() => void> = [];

        const registerListener = async (
            listenPromise: Promise<(() => void) | undefined>,
        ) => {
            const unlisten = await listenPromise;
            if (typeof unlisten !== "function") {
                return;
            }
            if (disposed) {
                void unlisten();
                return;
            }
            unsubs.push(unlisten);
        };

        const attachListeners = async () => {
            await Promise.all([
                registerListener(
                    listenToAiAuthTerminalStarted((payload) => {
                        if (payload.sessionId !== sessionIdRef.current) return;
                        setSnapshot(payload);
                        setRawOutput(payload.buffer);
                        resetOutputWithBuffer(payload.buffer);
                        setBusy(false);
                    }),
                ),
                registerListener(
                    listenToAiAuthTerminalOutput((payload) => {
                        if (payload.sessionId !== sessionIdRef.current) return;
                        setRawOutput((current) =>
                            appendTerminalRawOutput(current, payload.chunk),
                        );
                        emitOutputCommand({
                            type: "write",
                            data: payload.chunk,
                        });
                    }),
                ),
                registerListener(
                    listenToAiAuthTerminalExited((payload) => {
                        if (payload.sessionId !== sessionIdRef.current) return;
                        setSnapshot(payload);
                        setBusy(false);
                        void onRefreshSetupRef.current(runtimeId);
                    }),
                ),
                registerListener(
                    listenToAiAuthTerminalError((payload) => {
                        if (payload.sessionId !== sessionIdRef.current) return;
                        setSnapshot((current) => ({
                            ...current,
                            status: "error",
                            errorMessage: payload.message,
                        }));
                        setBusy(false);
                    }),
                ),
            ]);
        };

        const startSession = async () => {
            setBusy(true);
            setRawOutput("");
            resetOutputWithBuffer("");
            setSnapshot((current) => ({
                ...current,
                sessionId: "",
                status: "starting",
                errorMessage: null,
                exitCode: null,
            }));

            try {
                const nextSnapshot = await aiStartAuthTerminalSession({
                    runtimeId,
                    methodId,
                    vaultPath,
                    customBinaryPath,
                });
                if (disposed) {
                    void aiCloseAuthTerminalSession(
                        nextSnapshot.sessionId,
                    ).catch(() => undefined);
                    return;
                }
                sessionIdRef.current = nextSnapshot.sessionId;
                setSnapshot(nextSnapshot);
                setRawOutput(nextSnapshot.buffer);
                resetOutputWithBuffer(nextSnapshot.buffer);
                setBusy(false);
            } catch (error) {
                if (disposed) return;
                setSnapshot((current) => ({
                    ...current,
                    status: "error",
                    errorMessage: getErrorMessage(error),
                }));
                setBusy(false);
                await onRefreshSetupRef.current(runtimeId);
            }
        };

        void attachListeners().then(() => {
            if (disposed) {
                return;
            }
            void startSession();
        });
        // emitOutputCommand and resetOutputWithBuffer are stable (useCallback).

        return () => {
            disposed = true;
            const sessionId = sessionIdRef.current;
            sessionIdRef.current = null;
            if (sessionId) {
                void aiCloseAuthTerminalSession(sessionId).catch(
                    () => undefined,
                );
            }
            unsubs.forEach((unlisten) => {
                void unlisten();
            });
        };
    }, [
        open,
        runtimeId,
        methodId,
        vaultPath,
        customBinaryPath,
        emitOutputCommand,
        resetOutputWithBuffer,
    ]);

    const handleClose = useCallback(() => {
        const sessionId = sessionIdRef.current;
        sessionIdRef.current = null;
        if (sessionId) {
            void aiCloseAuthTerminalSession(sessionId).catch(() => undefined);
        }
        void onRefreshSetupRef.current(runtimeId);
        onClose();
    }, [onClose, runtimeId]);

    const handleRetry = useCallback(async () => {
        const sessionId = sessionIdRef.current;
        sessionIdRef.current = null;
        if (sessionId) {
            await aiCloseAuthTerminalSession(sessionId).catch(() => undefined);
        }

        setRawOutput("");
        resetOutputWithBuffer("");
        setSnapshot(buildInitialSnapshot(runtimeId, runtimeName, vaultPath));
        setBusy(true);

        try {
            const nextSnapshot = await aiStartAuthTerminalSession({
                runtimeId,
                methodId,
                vaultPath,
                customBinaryPath,
            });
            sessionIdRef.current = nextSnapshot.sessionId;
            setSnapshot(nextSnapshot);
            setRawOutput(nextSnapshot.buffer);
            resetOutputWithBuffer(nextSnapshot.buffer);
            setBusy(false);
        } catch (error) {
            setSnapshot((current) => ({
                ...current,
                status: "error",
                errorMessage: getErrorMessage(error),
            }));
            setBusy(false);
            await onRefreshSetupRef.current(runtimeId);
        }
    }, [
        customBinaryPath,
        methodId,
        runtimeId,
        runtimeName,
        vaultPath,
        resetOutputWithBuffer,
    ]);

    const sessionView = useMemo<TerminalSessionView>(
        () => ({
            snapshot,
            hasOutput: rawOutput.length > 0,
            busy,
            writeInput: async (input) => {
                const sessionId = sessionIdRef.current;
                if (!sessionId) return;
                await aiWriteAuthTerminalSession({ sessionId, data: input });
            },
            resize: async (cols, rows) => {
                const sessionId = sessionIdRef.current;
                if (!sessionId) return;
                const nextSnapshot = await aiResizeAuthTerminalSession({
                    sessionId,
                    cols,
                    rows,
                });
                setSnapshot(nextSnapshot);
            },
            restart: handleRetry,
            clearViewport: () => {
                setRawOutput("");
                resetOutputWithBuffer("");
            },
            subscribeOutput: (listener) => {
                const listeners = outputListenersRef.current;
                if (listeners.size === 0 && outputBacklogRef.current.length > 0) {
                    const pending = outputBacklogRef.current;
                    outputBacklogRef.current = [];
                    for (const command of pending) {
                        listener(command);
                    }
                }
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            getReplaySnapshot: () => replaySnapshotRef.current,
            saveReplaySnapshot: (serialized) => {
                replaySnapshotRef.current = serialized;
            },
        }),
        [snapshot, rawOutput, busy, handleRetry, resetOutputWithBuffer],
    );

    if (!open) return null;

    const terminalExited =
        snapshot.status === "exited" || snapshot.status === "error";
    const authSucceeded = authTerminalOutputIndicatesSuccess(
        runtimeId,
        rawOutput,
    );

    return (
        <>
            <div
                style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 110,
                    backgroundColor: "rgb(0 0 0 / 0.28)",
                    backdropFilter: "blur(6px)",
                }}
                onClick={handleClose}
            />
            <div
                style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 111,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 24,
                }}
            >
                <div
                    className="rounded-xl border"
                    style={{
                        width: "min(880px, 100%)",
                        height: "min(640px, calc(100vh - 48px))",
                        backgroundColor: "var(--bg-primary)",
                        borderColor: "var(--border)",
                        boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
                        display: "flex",
                        flexDirection: "column",
                        overflow: "hidden",
                    }}
                    onClick={(event) => event.stopPropagation()}
                >
                    <div
                        className="border-b px-5 py-4"
                        style={{ borderColor: "var(--border)" }}
                    >
                        <div
                            className="text-[11px] uppercase tracking-[0.16em]"
                            style={{ color: "var(--accent)" }}
                        >
                            Limited Terminal Sign-In
                        </div>
                        <div
                            className="mt-1 text-base font-semibold"
                            style={{ color: "var(--text-primary)" }}
                        >
                            Sign in to {runtimeName}
                        </div>
                        <div
                            className="mt-2 text-sm"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            This terminal is limited to the authentication flow.
                            It does not enable the full developer terminal.
                        </div>
                    </div>

                    <div
                        className="flex items-center justify-between gap-3 border-b px-5 py-3 text-xs"
                        style={{
                            borderColor: "var(--border)",
                            color: "var(--text-secondary)",
                        }}
                    >
                        <div>
                            Status:{" "}
                            <span style={{ color: "var(--text-primary)" }}>
                                {snapshot.status === "starting"
                                    ? "Starting sign-in terminal"
                                    : authSucceeded
                                      ? `${runtimeName} sign-in succeeded`
                                      : snapshot.status === "running"
                                      ? getRunningStatusLabel(runtimeName)
                                      : snapshot.status === "exited"
                                        ? "Terminal closed"
                                        : "Terminal error"}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={() => void onRefreshSetup(runtimeId)}
                            className="rounded-md px-2 py-1"
                            style={{
                                border: "1px solid var(--border)",
                                backgroundColor: "var(--bg-secondary)",
                                color: "var(--text-primary)",
                            }}
                        >
                            Check status
                        </button>
                    </div>

                    <div className="min-h-0 flex-1">
                        <TerminalViewport
                            autoFocus
                            initialScrollPosition="top"
                            session={sessionView}
                        />
                    </div>

                    {snapshot.errorMessage ? (
                        <div
                            className="border-t px-5 py-3 text-sm"
                            style={{
                                borderColor: "var(--border)",
                                color: "#fecaca",
                                backgroundColor:
                                    "color-mix(in srgb, #7f1d1d 10%, var(--bg-primary))",
                            }}
                        >
                            {snapshot.errorMessage}
                        </div>
                    ) : null}

                    <div
                        className="flex items-center justify-between gap-3 border-t px-5 py-4"
                        style={{ borderColor: "var(--border)" }}
                    >
                        <div
                            className="text-xs"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            {authSucceeded
                                ? `Sign-in completed. You can close this dialog; ${APP_BRAND_NAME} will refresh setup.`
                                : terminalExited
                                  ? `If sign-in completed, ${APP_BRAND_NAME} will detect it after refreshing setup.`
                                  : "Complete the sign-in flow in the terminal, then close this dialog or wait for it to exit."}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="rounded-md px-3 py-2 text-sm"
                                style={{
                                    border: "1px solid var(--border)",
                                    backgroundColor: "var(--bg-secondary)",
                                    color: "var(--text-primary)",
                                }}
                            >
                                Close
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleRetry()}
                                disabled={busy}
                                className="rounded-md px-3 py-2 text-sm"
                                style={{
                                    border: "none",
                                    opacity: busy ? 0.5 : 1,
                                    color: "#fff",
                                    background:
                                        "linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 56%, black))",
                                }}
                            >
                                Retry
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
