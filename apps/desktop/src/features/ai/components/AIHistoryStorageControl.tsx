import { useCallback, useEffect, useMemo, useState } from "react";
import { confirm } from "@neverwrite/runtime";
import { useVaultStore } from "../../../app/store/vaultStore";
import { useChatStore } from "../store/chatStore";
import type { AIStorageScope } from "../api";

export function AIHistoryStorageControl({
    compact = false,
}: {
    compact?: boolean;
}) {
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const status = useChatStore((state) => state.historyStorageStatus);
    const refreshStatus = useChatStore(
        (state) => state.refreshAiHistoryStorageStatus,
    );
    const changeStorage = useChatStore(
        (state) => state.changeAiHistoryStorage,
    );
    const [changing, setChanging] = useState(false);
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

    if (!vaultPath) return null;

    const isMoving = changing || status?.status === "moving";
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
