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
import { appendTerminalRawOutput } from "../../devtools/terminal/terminalRawOutput";
import { TerminalViewport } from "../../devtools/terminal/TerminalViewport";
import {
    EMPTY_TERMINAL_SNAPSHOT,
    type TerminalSessionView,
} from "../../devtools/terminal/terminalTypes";

interface AIAuthTerminalModalProps {
    open: boolean;
    runtimeId: string;
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

export function AIAuthTerminalModal({
    open,
    runtimeId,
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

        const attachListeners = async () => {
            unsubs.push(
                await listenToAiAuthTerminalStarted((payload) => {
                    if (payload.sessionId !== sessionIdRef.current) return;
                    setSnapshot(payload);
                    setRawOutput(payload.buffer);
                    setBusy(false);
                }),
            );
            unsubs.push(
                await listenToAiAuthTerminalOutput((payload) => {
                    if (payload.sessionId !== sessionIdRef.current) return;
                    setRawOutput((current) =>
                        appendTerminalRawOutput(current, payload.chunk),
                    );
                }),
            );
            unsubs.push(
                await listenToAiAuthTerminalExited((payload) => {
                    if (payload.sessionId !== sessionIdRef.current) return;
                    setSnapshot(payload);
                    setBusy(false);
                    void onRefreshSetup(runtimeId);
                }),
            );
            unsubs.push(
                await listenToAiAuthTerminalError((payload) => {
                    if (payload.sessionId !== sessionIdRef.current) return;
                    setSnapshot((current) => ({
                        ...current,
                        status: "error",
                        errorMessage: payload.message,
                    }));
                    setBusy(false);
                }),
            );
        };

        const startSession = async () => {
            setBusy(true);
            setRawOutput("");
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
                setBusy(false);
            } catch (error) {
                if (disposed) return;
                setSnapshot((current) => ({
                    ...current,
                    status: "error",
                    errorMessage: getErrorMessage(error),
                }));
                setBusy(false);
                await onRefreshSetup(runtimeId);
            }
        };

        void attachListeners().then(startSession);

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
    }, [open, runtimeId, vaultPath, customBinaryPath, onRefreshSetup]);

    const handleClose = useCallback(() => {
        const sessionId = sessionIdRef.current;
        sessionIdRef.current = null;
        if (sessionId) {
            void aiCloseAuthTerminalSession(sessionId).catch(() => undefined);
        }
        void onRefreshSetup(runtimeId);
        onClose();
    }, [onClose, onRefreshSetup, runtimeId]);

    const handleRetry = useCallback(async () => {
        const sessionId = sessionIdRef.current;
        sessionIdRef.current = null;
        if (sessionId) {
            await aiCloseAuthTerminalSession(sessionId).catch(() => undefined);
        }

        setRawOutput("");
        setSnapshot(buildInitialSnapshot(runtimeId, runtimeName, vaultPath));
        setBusy(true);

        try {
            const nextSnapshot = await aiStartAuthTerminalSession({
                runtimeId,
                vaultPath,
                customBinaryPath,
            });
            sessionIdRef.current = nextSnapshot.sessionId;
            setSnapshot(nextSnapshot);
            setRawOutput(nextSnapshot.buffer);
            setBusy(false);
        } catch (error) {
            setSnapshot((current) => ({
                ...current,
                status: "error",
                errorMessage: getErrorMessage(error),
            }));
            setBusy(false);
            await onRefreshSetup(runtimeId);
        }
    }, [customBinaryPath, onRefreshSetup, runtimeId, runtimeName, vaultPath]);

    const sessionView = useMemo<TerminalSessionView>(
        () => ({
            snapshot,
            rawOutput,
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
            },
        }),
        [snapshot, rawOutput, busy, handleRetry],
    );

    if (!open) return null;

    const terminalExited =
        snapshot.status === "exited" || snapshot.status === "error";

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
                        <TerminalViewport session={sessionView} />
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
                            {terminalExited
                                ? "If sign-in completed, VaultAI will detect it after refreshing setup."
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
