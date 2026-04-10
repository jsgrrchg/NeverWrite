import { useMemo, useState, type ReactNode } from "react";
import {
    type Tab,
    isNoteTab,
    selectEditorPaneState,
    useEditorStore,
} from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";

function renderTabLeadingIcon(tab: Tab): ReactNode {
    if (tab.kind === "pdf") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background: "color-mix(in srgb, #e24b3b 12%, transparent)",
                    color: "#e24b3b",
                }}
            >
                PDF
            </span>
        );
    }

    if (tab.kind === "file") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background:
                        "color-mix(in srgb, var(--text-secondary) 12%, transparent)",
                    color: "var(--text-secondary)",
                }}
            >
                F
            </span>
        );
    }

    if (tab.kind === "ai-review") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background:
                        "color-mix(in srgb, var(--accent) 12%, transparent)",
                    color: "var(--accent)",
                }}
            >
                AI
            </span>
        );
    }

    if (tab.kind === "map") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background:
                        "color-mix(in srgb, var(--accent) 12%, transparent)",
                    color: "var(--accent)",
                }}
            >
                M
            </span>
        );
    }

    if (tab.kind === "graph") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background:
                        "color-mix(in srgb, var(--accent) 12%, transparent)",
                    color: "var(--accent)",
                }}
            >
                G
            </span>
        );
    }

    return (
        <span
            aria-hidden="true"
            className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
            style={{
                background:
                    "color-mix(in srgb, var(--text-secondary) 10%, transparent)",
                color: "var(--text-secondary)",
            }}
        >
            N
        </span>
    );
}

function getTabLabel(tab: Tab, fileTreeShowExtensions: boolean) {
    if (fileTreeShowExtensions && isNoteTab(tab)) {
        const baseName = tab.noteId.split("/").pop() || tab.title;
        return tab.noteId ? `${baseName}.md` : baseName;
    }
    return tab.title;
}

interface EditorPaneBarProps {
    paneId: string;
    isFocused: boolean;
}

export function EditorPaneBar({ paneId, isFocused }: EditorPaneBarProps) {
    const pane = useEditorStore((state) =>
        selectEditorPaneState(state, paneId),
    );
    const panes = useEditorStore((state) => state.panes);
    const switchTab = useEditorStore((state) => state.switchTab);
    const closeTab = useEditorStore((state) => state.closeTab);
    const closePane = useEditorStore((state) => state.closePane);
    const moveTabToPane = useEditorStore((state) => state.moveTabToPane);
    const insertExternalTabInPane = useEditorStore(
        (state) => state.insertExternalTabInPane,
    );
    const fileTreeShowExtensions = useSettingsStore(
        (state) => state.fileTreeShowExtensions,
    );
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const [tabContextMenu, setTabContextMenu] = useState<ContextMenuState<{
        tabId: string;
    }> | null>(null);
    const [paneContextMenu, setPaneContextMenu] = useState<ContextMenuState<{
        paneId: string;
    }> | null>(null);

    const paneIndex = panes.findIndex((candidate) => candidate.id === paneId);
    const movableTargets = useMemo(
        () =>
            panes
                .map((candidate, index) => ({
                    id: candidate.id,
                    index,
                }))
                .filter((candidate) => candidate.id !== paneId),
        [paneId, panes],
    );

    return (
        <>
            <div
                className="flex items-center gap-1 px-2 py-1 shrink-0 overflow-x-auto scrollbar-hidden"
                style={{
                    minHeight: 38,
                    borderBottom: "1px solid var(--border)",
                    background: isFocused
                        ? "color-mix(in srgb, var(--bg-secondary) 96%, var(--accent) 4%)"
                        : "var(--bg-secondary)",
                }}
            >
                {pane.tabs.map((tab) => {
                    const isActive = tab.id === pane.activeTabId;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            data-pane-tab-id={tab.id}
                            onClick={() => switchTab(tab.id)}
                            onContextMenu={(event) => {
                                event.preventDefault();
                                setTabContextMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    payload: { tabId: tab.id },
                                });
                            }}
                            className="group inline-flex min-w-0 max-w-55 shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
                            style={{
                                border: isActive
                                    ? "1px solid color-mix(in srgb, var(--accent) 18%, var(--border))"
                                    : "1px solid color-mix(in srgb, var(--border) 46%, transparent)",
                                background: isActive
                                    ? "var(--bg-primary)"
                                    : "color-mix(in srgb, var(--bg-primary) 38%, transparent)",
                                color: isActive
                                    ? "var(--text-primary)"
                                    : "var(--text-secondary)",
                                boxShadow: isActive
                                    ? "0 10px 24px rgba(15, 23, 42, 0.08)"
                                    : "none",
                            }}
                        >
                            {renderTabLeadingIcon(tab)}
                            <span className="truncate text-[12px] font-medium">
                                {getTabLabel(tab, fileTreeShowExtensions)}
                            </span>
                            <span
                                title={`Close ${tab.title}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    closeTab(tab.id);
                                }}
                                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-45 transition group-hover:opacity-100"
                                style={{ color: "inherit" }}
                            >
                                <svg
                                    width="10"
                                    height="10"
                                    viewBox="0 0 16 16"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M4 4l8 8M4 12l8-8" />
                                </svg>
                            </span>
                        </button>
                    );
                })}

                {vaultPath && (
                    <button
                        type="button"
                        onClick={() =>
                            insertExternalTabInPane(
                                {
                                    id: crypto.randomUUID(),
                                    kind: "note",
                                    noteId: "",
                                    title: "New Tab",
                                    content: "",
                                },
                                paneId,
                            )
                        }
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                        aria-label="New tab"
                        title="New tab"
                        style={{
                            border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                            color: "var(--text-secondary)",
                            background: "transparent",
                        }}
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M8 3.5v9M3.5 8h9" />
                        </svg>
                    </button>
                )}

                <button
                    type="button"
                    onClick={(event) =>
                        setPaneContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            payload: { paneId },
                        })
                    }
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    aria-label={`Pane ${paneIndex + 1} actions`}
                    title={`Pane ${paneIndex + 1} actions`}
                    style={{
                        border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                        color: "var(--text-secondary)",
                        background: "transparent",
                    }}
                >
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                    >
                        <circle cx="8" cy="3.5" r="1.25" />
                        <circle cx="8" cy="8" r="1.25" />
                        <circle cx="8" cy="12.5" r="1.25" />
                    </svg>
                </button>
            </div>

            {tabContextMenu && (
                <ContextMenu
                    menu={tabContextMenu}
                    onClose={() => setTabContextMenu(null)}
                    entries={(() => {
                        const targetTab =
                            pane.tabs.find(
                                (candidate) =>
                                    candidate.id ===
                                    tabContextMenu.payload.tabId,
                            ) ?? null;
                        if (!targetTab) {
                            return [];
                        }

                        const entries: ContextMenuEntry[] = [
                            {
                                label: "Close",
                                action: () => closeTab(targetTab.id),
                            },
                        ];

                        if (movableTargets.length > 0) {
                            entries.push({ type: "separator" });
                            entries.push(
                                ...movableTargets.map((target) => ({
                                    label: `Move to Pane ${target.index + 1}`,
                                    action: () =>
                                        moveTabToPane(targetTab.id, target.id),
                                })),
                            );
                        }

                        return entries;
                    })()}
                />
            )}

            {paneContextMenu && (
                <ContextMenu
                    menu={paneContextMenu}
                    onClose={() => setPaneContextMenu(null)}
                    entries={[
                        {
                            label: `Close Pane ${paneIndex + 1}`,
                            action: () => closePane(paneId),
                            disabled: panes.length <= 1,
                        },
                    ]}
                />
            )}
        </>
    );
}
