import { useCallback, useEffect, useMemo, useState } from "react";
import { confirm, revealItemInDir } from "@neverwrite/runtime";
import {
    getAiHistoryRecoveryDiagnostic,
    getAiHistoryRecoveryRevealPath,
    retryAiHistoryRecovery,
} from "../api";
import { useChatStore } from "../store/chatStore";
import type {
    AIHistoryRecoveryDiagnostic,
    AIHistoryRecoveryRootId,
    AIStorageScope,
} from "../api";

export function AIHistoryStorageControl({
    vaultPath,
    compact = false,
}: {
    vaultPath: string | null;
    compact?: boolean;
}) {
    const status = useChatStore((state) =>
        state.historyStorageVaultPath === vaultPath
            ? state.historyStorageStatus
            : null,
    );
    const refreshStatus = useChatStore(
        (state) => state.refreshAiHistoryStorageStatus,
    );
    const changeStorage = useChatStore(
        (state) => state.changeAiHistoryStorage,
    );
    const [changing, setChanging] = useState(false);
    const [recoveryActionPending, setRecoveryActionPending] = useState(false);
    const [recoveryDiagnostic, setRecoveryDiagnostic] =
        useState<AIHistoryRecoveryDiagnostic | null>(null);
    const recovery =
        status?.status === "recovery_required" ? status.details : null;
    const ready = status?.status === "ready" ? status : null;
    const orphanedDeviceHistories = useMemo(
        () => ready?.orphanedDeviceHistories ?? [],
        [ready],
    );
    const [selectedOrphanKey, setSelectedOrphanKey] = useState<string | null>(
        null,
    );

    useEffect(() => {
        if (!vaultPath) return;
        const refresh = () => void refreshStatus(vaultPath);
        refresh();
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
    }, [refreshStatus, vaultPath]);

    useEffect(() => {
        setSelectedOrphanKey((current) =>
            orphanedDeviceHistories.some(
                (candidate) => candidate.vaultKey === current,
            )
                ? current
                : (orphanedDeviceHistories[0]?.vaultKey ?? null),
        );
    }, [orphanedDeviceHistories]);

    useEffect(() => {
        let active = true;
        if (!vaultPath || !recovery) {
            setRecoveryDiagnostic(null);
            return () => {
                active = false;
            };
        }
        void getAiHistoryRecoveryDiagnostic(vaultPath)
            .then((diagnostic) => {
                if (active) setRecoveryDiagnostic(diagnostic);
            })
            .catch(() => {
                if (active) setRecoveryDiagnostic(null);
            });
        return () => {
            active = false;
        };
    }, [recovery, vaultPath]);

    const requestChange = useCallback(
        async (target: AIStorageScope, sourceVaultKey?: string) => {
            if (!vaultPath || changing) return;
            const accepted = await confirm(
                "This moves all saved AI chats and NeverWrite-managed pasted attachments. The storage setting changes only after the move succeeds.",
                {
                    title:
                        target === "vault"
                            ? "Move all AI chats into this vault?"
                            : "Move all AI chats to this device?",
                    kind: "warning",
                    okLabel: "Move all chats",
                    cancelLabel: "Cancel",
                },
            );
            if (!accepted) return;
            setChanging(true);
            try {
                if (sourceVaultKey) {
                    await changeStorage(vaultPath, target, sourceVaultKey);
                } else {
                    await changeStorage(vaultPath, target);
                }
            } finally {
                setChanging(false);
            }
        },
        [
            changeStorage,
            changing,
            vaultPath,
        ],
    );

    const revealRecoveryRoot = useCallback(
        async (root: AIHistoryRecoveryRootId) => {
            if (!vaultPath || recoveryActionPending) return;
            setRecoveryActionPending(true);
            try {
                await revealItemInDir(
                    await getAiHistoryRecoveryRevealPath(vaultPath, root),
                );
            } finally {
                setRecoveryActionPending(false);
            }
        },
        [recoveryActionPending, vaultPath],
    );

    const exportRecoveryDiagnostic = useCallback(async () => {
        if (!vaultPath || recoveryActionPending) return;
        setRecoveryActionPending(true);
        try {
            const diagnostic = await getAiHistoryRecoveryDiagnostic(vaultPath);
            const blob = new Blob([JSON.stringify(diagnostic, null, 2)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "neverwrite-ai-history-recovery.json";
            link.click();
            URL.revokeObjectURL(url);
        } finally {
            setRecoveryActionPending(false);
        }
    }, [recoveryActionPending, vaultPath]);

    const retryRecovery = useCallback(async () => {
        if (!vaultPath || recoveryActionPending) return;
        setRecoveryActionPending(true);
        try {
            await retryAiHistoryRecovery(vaultPath);
            await refreshStatus(vaultPath);
        } finally {
            setRecoveryActionPending(false);
        }
    }, [recoveryActionPending, refreshStatus, vaultPath]);

    if (!vaultPath) return null;

    const isMoving =
        changing || recoveryActionPending || status?.status === "moving";
    const conflictingIds = recovery
        ? [
              ...recovery.conflictingSessionIds,
              ...recovery.conflictingAttachmentIds,
          ]
        : [];

    return (
        <div
            className={compact ? "px-3 py-2" : "py-2"}
            style={
                compact
                    ? { borderBottom: "1px solid var(--border)" }
                    : undefined
            }
        >
            <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                    <div
                        className="text-xs font-medium"
                        style={{ color: "var(--text-primary)" }}
                    >
                        Store AI chats inside this vault
                    </div>
                    {!compact ? (
                        <div
                            className="mt-0.5 max-w-xl text-[11px] leading-relaxed"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            AI chat history and pasted attachments will sync or
                            be shared with this vault. Keep this off for shared
                            or cloud-synced vaults.
                        </div>
                    ) : null}
                </div>
                {ready ? (
                    <button
                        type="button"
                        role="switch"
                        aria-label="Store AI chats inside this vault"
                        aria-checked={ready.scope === "vault"}
                        disabled={isMoving}
                        onClick={() =>
                            void requestChange(
                                ready.scope === "vault" ? "device" : "vault",
                            )
                        }
                        className="nw-settings-toggle relative h-5 w-9 shrink-0 rounded-full border-0"
                        style={{
                            cursor: isMoving ? "not-allowed" : "pointer",
                            opacity: isMoving ? 0.45 : 1,
                            backgroundColor:
                                ready.scope === "vault"
                                    ? "var(--accent)"
                                    : "var(--bg-tertiary)",
                        }}
                    >
                        <span
                            className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow"
                            style={{
                                left: ready.scope === "vault" ? 18 : 2,
                                transition: "left 150ms",
                            }}
                        />
                    </button>
                ) : (
                    <span
                        className="shrink-0 text-[10px]"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {isMoving ? "Moving chats…" : "Needs attention"}
                    </span>
                )}
            </div>

            {recovery ? (
                <div
                    className="mt-2 rounded-md p-2 text-[11px]"
                    style={{
                        color: "var(--text-secondary)",
                        backgroundColor: "var(--bg-tertiary)",
                        border: "1px solid var(--border)",
                    }}
                >
                    <div>{recovery.message}</div>
                    {conflictingIds.length > 0 ? (
                        <div className="mt-1 font-mono">
                            Conflicts: {conflictingIds.join(", ")}
                        </div>
                    ) : null}
                    {recovery.canReconcile ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                            <button
                                type="button"
                                disabled={isMoving}
                                onClick={() => void requestChange("device")}
                                className="rounded px-2 py-1 text-[11px]"
                                style={{
                                    color: "var(--text-primary)",
                                    border: "1px solid var(--border)",
                                }}
                            >
                                Use this device
                            </button>
                            <button
                                type="button"
                                disabled={isMoving}
                                onClick={() => void requestChange("vault")}
                                className="rounded px-2 py-1 text-[11px]"
                                style={{
                                    color: "var(--text-primary)",
                                    border: "1px solid var(--border)",
                                }}
                            >
                                Use this vault
                            </button>
                        </div>
                    ) : null}
                    {!recovery.canReconcile ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                            {recoveryDiagnostic?.roots
                                .filter((root) => root.hasData)
                                .map((root) => (
                                    <button
                                        key={root.id}
                                        type="button"
                                        disabled={isMoving}
                                        onClick={() =>
                                            void revealRecoveryRoot(root.id)
                                        }
                                        className="rounded px-2 py-1 text-[11px]"
                                        style={{
                                            color: "var(--text-primary)",
                                            border: "1px solid var(--border)",
                                        }}
                                    >
                                        Reveal {root.label}
                                    </button>
                                ))}
                            <button
                                type="button"
                                disabled={isMoving}
                                onClick={() => void exportRecoveryDiagnostic()}
                                className="rounded px-2 py-1 text-[11px]"
                                style={{
                                    color: "var(--text-primary)",
                                    border: "1px solid var(--border)",
                                }}
                            >
                                Export diagnostic
                            </button>
                            <button
                                type="button"
                                disabled={isMoving}
                                onClick={() => void retryRecovery()}
                                className="rounded px-2 py-1 text-[11px]"
                                style={{
                                    color: "var(--text-primary)",
                                    border: "1px solid var(--border)",
                                }}
                            >
                                Retry
                            </button>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {ready && orphanedDeviceHistories.length > 0 ? (
                <div
                    className="mt-2 rounded-md p-2 text-[11px]"
                    style={{
                        color: "var(--text-secondary)",
                        backgroundColor: "var(--bg-tertiary)",
                        border: "1px solid var(--border)",
                    }}
                >
                    <div>
                        Device-local chats from a previous vault are available
                        to import.
                    </div>
                    <label className="mt-2 block">
                        <span className="block">Previous vault path</span>
                        <select
                            aria-label="Previous vault path"
                            value={selectedOrphanKey ?? ""}
                            onChange={(event) =>
                                setSelectedOrphanKey(event.target.value)
                            }
                            className="mt-1 w-full rounded px-2 py-1 text-[11px]"
                            style={{
                                color: "var(--text-primary)",
                                backgroundColor: "var(--bg-primary)",
                                border: "1px solid var(--border)",
                            }}
                        >
                            {orphanedDeviceHistories.map((candidate) => (
                                <option
                                    key={candidate.vaultKey}
                                    value={candidate.vaultKey}
                                >
                                    {candidate.previousVaultPath}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="mt-2 flex flex-wrap gap-2">
                        <button
                            type="button"
                            disabled={isMoving || !selectedOrphanKey}
                            onClick={() =>
                                void requestChange(
                                    "device",
                                    selectedOrphanKey ?? undefined,
                                )
                            }
                            className="rounded px-2 py-1 text-[11px]"
                            style={{
                                color: "var(--text-primary)",
                                border: "1px solid var(--border)",
                            }}
                        >
                            Import to this device
                        </button>
                        <button
                            type="button"
                            disabled={isMoving || !selectedOrphanKey}
                            onClick={() =>
                                void requestChange(
                                    "vault",
                                    selectedOrphanKey ?? undefined,
                                )
                            }
                            className="rounded px-2 py-1 text-[11px]"
                            style={{
                                color: "var(--text-primary)",
                                border: "1px solid var(--border)",
                            }}
                        >
                            Import into this vault
                        </button>
                    </div>
                </div>
            ) : null}

            {status?.status === "error" ? (
                <div className="mt-2 text-[11px] text-red-500">
                    {status.message}
                </div>
            ) : null}
        </div>
    );
}
