import { useEditorStore, selectPaneCount } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useChatStore } from "../ai/store/chatStore";
import {
    openNewAgentInPane,
    openNewNoteInPane,
} from "./newTabMenuActions";

interface WorkspacePaneEmptyStateProps {
    paneId: string;
}

function EmptyStateButton({
    label,
    onClick,
    disabled = false,
    secondary = false,
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    secondary?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition"
            style={{
                border: secondary
                    ? "1px solid color-mix(in srgb, var(--border) 82%, transparent)"
                    : "1px solid color-mix(in srgb, var(--accent) 18%, var(--border))",
                background: secondary
                    ? "transparent"
                    : "color-mix(in srgb, var(--accent) 10%, var(--bg-primary))",
                color: secondary
                    ? "var(--text-secondary)"
                    : "var(--text-primary)",
                opacity: disabled ? 0.45 : 1,
                cursor: disabled ? "default" : "pointer",
            }}
        >
            {label}
        </button>
    );
}

export function WorkspacePaneEmptyState({
    paneId,
}: WorkspacePaneEmptyStateProps) {
    const paneCount = useEditorStore(selectPaneCount);
    const closePane = useEditorStore((state) => state.closePane);
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const runtimeCount = useChatStore((state) => state.runtimes.length);
    const canCreateNote = Boolean(vaultPath);
    const canCreateAgent = runtimeCount > 0;

    return (
        <div
            className="flex h-full items-center justify-center p-6"
            data-workspace-empty-pane={paneId}
        >
            <div
                className="flex w-full max-w-xl flex-col items-center rounded-2xl px-6 py-7 text-center"
                style={{
                    border: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
                    background:
                        "color-mix(in srgb, var(--bg-secondary) 78%, transparent)",
                    boxShadow: "0 18px 48px rgba(15, 23, 42, 0.08)",
                }}
            >
                <div
                    className="rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]"
                    style={{
                        border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
                        color: "var(--text-secondary)",
                        background:
                            "color-mix(in srgb, var(--bg-primary) 72%, transparent)",
                    }}
                >
                    Empty Pane
                </div>

                <h2
                    className="mt-4 text-lg font-semibold"
                    style={{ color: "var(--text-primary)" }}
                >
                    Start something in this pane
                </h2>

                <p
                    className="mt-2 max-w-md text-sm leading-6"
                    style={{ color: "var(--text-secondary)" }}
                >
                    {canCreateNote
                        ? "Open a note or launch an agent here. Empty panes stay lightweight so the workspace can stay spatial."
                        : "Open a vault to work with notes, or launch an agent here to start a new workspace conversation."}
                </p>

                <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                    <EmptyStateButton
                        label="New Note"
                        disabled={!canCreateNote}
                        onClick={() => {
                            void openNewNoteInPane(paneId);
                        }}
                    />
                    <EmptyStateButton
                        label="New Agent"
                        disabled={!canCreateAgent}
                        onClick={() => {
                            void openNewAgentInPane(paneId);
                        }}
                    />
                    {paneCount > 1 && (
                        <EmptyStateButton
                            label="Close Pane"
                            secondary
                            onClick={() => closePane(paneId)}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
