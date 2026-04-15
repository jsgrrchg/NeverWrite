import { Fragment, useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { createPortal } from "react-dom";
import {
    type Tab,
    isChatTab,
    isFileTab,
    isNoteTab,
    isPdfTab,
    selectEditorPaneState,
    selectEditorWorkspaceTabs,
    selectLeafPaneIds,
    selectPaneCount,
    selectPaneNeighbor,
    useEditorStore,
} from "../../app/store/editorStore";
import { getSessionTitle } from "../ai/sessionPresentation";
import { useChatStore } from "../ai/store/chatStore";
import { useInlineRename } from "../ai/components/useInlineRename";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { getWindowMode } from "../../app/detachedWindows";
import {
    buildNewTabContextMenuEntries,
    openBlankDraftTabFromPlusButton,
} from "./newTabMenuActions";
import {
    buildTabFileDragDetail,
    resolveComposerDropTarget,
} from "./tabDragAttachments";
import { renderEditorTabLeadingIcon } from "./editorTabIcons";
import { useResponsiveEditorTabLayout } from "./editorTabStripLayout";
import { useWorkspaceTabDrag } from "./useWorkspaceTabDrag";
import { useDetachedTabWindowDrop } from "./useDetachedTabWindowDrop";
import {
    chromeControlsGroupStyle,
    getChromeIconButtonStyle,
    getChromeNavigationButtonStyle,
} from "./workspaceChromeControls";

function getTabLabel(
    tab: Tab,
    fileTreeShowExtensions: boolean,
    chatSessionsById: ReturnType<typeof useChatStore.getState>["sessionsById"],
) {
    if (isChatTab(tab)) {
        const session = chatSessionsById[tab.sessionId];
        return session ? getSessionTitle(session) : tab.title;
    }

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

function getPaneHeaderActionButtonStyle(active = false) {
    return {
        ...getChromeIconButtonStyle(active),
        width: 22,
        height: 22,
        borderRadius: 6,
        opacity: 1,
        boxShadow: "none",
    };
}

export function EditorPaneBar({ paneId, isFocused }: EditorPaneBarProps) {
    void isFocused;
    const pane = useEditorStore((state) =>
        selectEditorPaneState(state, paneId),
    );
    const chatSessionsById = useChatStore((state) => state.sessionsById);
    const renameChatSession = useChatStore((state) => state.renameSession);
    const paneIds = useEditorStore(useShallow(selectLeafPaneIds));
    const paneCount = useEditorStore(selectPaneCount);
    const reorderPaneTabs = useEditorStore((state) => state.reorderPaneTabs);
    const switchTab = useEditorStore((state) => state.switchTab);
    const closeTab = useEditorStore((state) => state.closeTab);
    const goBack = useEditorStore((state) => state.goBack);
    const goForward = useEditorStore((state) => state.goForward);
    const closePane = useEditorStore((state) => state.closePane);
    const splitEditorPane = useEditorStore((state) => state.splitEditorPane);
    const balancePaneLayout = useEditorStore(
        (state) => state.balancePaneLayout,
    );
    const unifyAllPanesInto = useEditorStore(
        (state) => state.unifyAllPanesInto,
    );
    const focusPaneNeighbor = useEditorStore(
        (state) => state.focusPaneNeighbor,
    );
    const moveTabToNewSplit = useEditorStore(
        (state) => state.moveTabToNewSplit,
    );
    const moveTabToPane = useEditorStore((state) => state.moveTabToPane);
    const moveTabToPaneDropTarget = useEditorStore(
        (state) => state.moveTabToPaneDropTarget,
    );
    const fileTreeShowExtensions = useSettingsStore(
        (state) => state.fileTreeShowExtensions,
    );
    const tabOpenBehavior = useSettingsStore((state) => state.tabOpenBehavior);
    const developerModeEnabled = useSettingsStore(
        (state) => state.developerModeEnabled,
    );
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const [tabContextMenu, setTabContextMenu] = useState<ContextMenuState<{
        tabId: string;
    }> | null>(null);
    const [paneContextMenu, setPaneContextMenu] = useState<ContextMenuState<{
        paneId: string;
    }> | null>(null);
    const [newTabContextMenu, setNewTabContextMenu] =
        useState<ContextMenuState<void> | null>(null);
    const windowMode = getWindowMode();
    const {
        editingKey,
        editValue,
        inputRef,
        setEditValue,
        startEditing,
        cancelEditing,
        commitEditing,
    } = useInlineRename<string>();

    const paneIndex = paneIds.indexOf(paneId);
    const canCreateSplit = true;
    const hasTabs = pane.tabs.length > 0;
    const paneLabel = `Pane ${paneIndex + 1}`;
    const activePaneTab =
        pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
    const canGoBack =
        tabOpenBehavior === "history"
            ? activePaneTab &&
              (isNoteTab(activePaneTab) ||
                  isFileTab(activePaneTab) ||
                  isPdfTab(activePaneTab))
                ? activePaneTab.historyIndex > 0
                : false
            : pane.tabNavigationIndex > 0;
    const canGoForward =
        tabOpenBehavior === "history"
            ? activePaneTab &&
              (isNoteTab(activePaneTab) ||
                  isFileTab(activePaneTab) ||
                  isPdfTab(activePaneTab))
                ? activePaneTab.historyIndex < activePaneTab.history.length - 1
                : false
            : pane.tabNavigationIndex < pane.tabNavigationHistory.length - 1;
    const leftNeighborPaneId = useEditorStore((state) =>
        selectPaneNeighbor(state, paneId, "left"),
    );
    const rightNeighborPaneId = useEditorStore((state) =>
        selectPaneNeighbor(state, paneId, "right"),
    );
    const upNeighborPaneId = useEditorStore((state) =>
        selectPaneNeighbor(state, paneId, "up"),
    );
    const downNeighborPaneId = useEditorStore((state) =>
        selectPaneNeighbor(state, paneId, "down"),
    );
    const detachedTabWindowDrop = useDetachedTabWindowDrop({
        vaultPath,
        windowMode,
        getTabById: (tabId) =>
            selectEditorWorkspaceTabs(useEditorStore.getState()).find(
                (candidate) => candidate.id === tabId,
            ) ?? null,
        getWorkspaceTabCount: () =>
            selectEditorWorkspaceTabs(useEditorStore.getState()).length,
        closeTab,
    });

    const {
        dragPreviewNodeRef,
        dragPreviewTabId,
        draggingTabId,
        projectedDropIndex,
        tabStripRef,
        visualTabs,
        registerTabNode,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleLostPointerCapture,
        consumeSuppressedClick,
    } = useWorkspaceTabDrag({
        tabs: pane.tabs,
        sourcePaneId: paneId,
        onCommitReorder: (fromIndex, toIndex) =>
            reorderPaneTabs(paneId, fromIndex, toIndex),
        onCommitWorkspaceDrop: (tabId, target) => {
            if (target.type === "strip") {
                moveTabToPane(tabId, target.paneId, target.index);
                return;
            }

            if (target.type === "pane-center") {
                if (target.paneId !== paneId) {
                    moveTabToPane(tabId, target.paneId);
                }
                return;
            }

            moveTabToPaneDropTarget(tabId, target.paneId, target.direction);
        },
        onActivate: switchTab,
        liveReorder: false,
        resolveExternalDropTarget: (tabId, coords) => {
            const composerTarget = resolveComposerDropTarget(
                coords.clientX,
                coords.clientY,
            );
            if (composerTarget.type !== "none") {
                return composerTarget;
            }

            return detachedTabWindowDrop.resolveDetachDropTarget(tabId, coords);
        },
        onCommitExternalDrop: (tabId, target, coords) => {
            if (target.type !== "detach-window") {
                return;
            }

            return detachedTabWindowDrop.commitDetachDrop(tabId, coords);
        },
        onDetachStart: detachedTabWindowDrop.handleDetachStart,
        onDetachMove: detachedTabWindowDrop.handleDetachMove,
        onDetachCancel: detachedTabWindowDrop.handleDetachCancel,
        buildAttachmentDetail: (tabId, phase, coords) => {
            const tab =
                pane.tabs.find((candidate) => candidate.id === tabId) ?? null;
            if (!tab) {
                return null;
            }

            return buildTabFileDragDetail(tab, phase, coords, {
                resolveNotePath: (noteId) =>
                    useVaultStore
                        .getState()
                        .notes.find((note) => note.id === noteId)?.path ?? null,
            });
        },
    });
    const tabLayout = useResponsiveEditorTabLayout({
        stripRef: tabStripRef,
        tabCount: visualTabs.length,
        freeze: draggingTabId !== null,
    });
    const draggedPreviewTab =
        dragPreviewTabId === null
            ? null
            : (pane.tabs.find((tab) => tab.id === dragPreviewTabId) ?? null);
    const draggingOriginalIndex = draggingTabId
        ? pane.tabs.findIndex((tab) => tab.id === draggingTabId)
        : -1;
    const localInsertionIndicatorIndex =
        draggingOriginalIndex === -1 || projectedDropIndex == null
            ? null
            : projectedDropIndex > draggingOriginalIndex
              ? projectedDropIndex + 1
              : projectedDropIndex;
    const insertionIndicatorIndex = localInsertionIndicatorIndex;
    const handleTabClick = useCallback(
        (tabId: string) => {
            if (editingKey === tabId) return;
            if (consumeSuppressedClick(tabId)) return;
            switchTab(tabId);
        },
        [consumeSuppressedClick, editingKey, switchTab],
    );
    const beginChatRename = useCallback(
        (tab: Tab) => {
            if (!isChatTab(tab)) return;
            const session = chatSessionsById[tab.sessionId];
            if (!session) return;
            switchTab(tab.id);
            startEditing(tab.id, getSessionTitle(session));
        },
        [chatSessionsById, startEditing, switchTab],
    );
    const commitChatRename = useCallback(
        (tabId: string, value: string | null) => {
            const tab = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            ).find((candidate) => candidate.id === tabId);
            if (!tab || !isChatTab(tab)) return;
            renameChatSession(tab.sessionId, value);
        },
        [renameChatSession],
    );

    return (
        <>
            <div
                className="flex items-center shrink-0"
                style={{
                    height: 33,
                    minHeight: 33,
                    boxSizing: "border-box",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg-secondary)",
                }}
                data-pane-empty={hasTabs ? undefined : "true"}
            >
                <div className="flex shrink-0 items-center px-1.5">
                    <div
                        className="flex shrink-0 items-center"
                        style={chromeControlsGroupStyle}
                    >
                        <button
                            type="button"
                            onClick={goBack}
                            disabled={!canGoBack}
                            title="Go back"
                            className="flex shrink-0 items-center justify-center"
                            style={getChromeNavigationButtonStyle(
                                "leading",
                                canGoBack,
                            )}
                        >
                            <svg
                                width="11"
                                height="11"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M9.5 3L4.5 8l5 5" />
                            </svg>
                        </button>
                        <button
                            type="button"
                            onClick={goForward}
                            disabled={!canGoForward}
                            title="Go forward"
                            className="flex shrink-0 items-center justify-center"
                            style={getChromeNavigationButtonStyle(
                                "trailing",
                                canGoForward,
                            )}
                        >
                            <svg
                                width="11"
                                height="11"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M6.5 3L11.5 8l-5 5" />
                            </svg>
                        </button>
                    </div>
                </div>

                <div className="relative flex min-w-0 flex-1 self-stretch overflow-hidden">
                    {hasTabs ? (
                        <div
                            ref={tabStripRef}
                            data-pane-tab-strip={paneId}
                            data-pane-tab-density={tabLayout.density}
                            data-pane-tab-overflowing={
                                tabLayout.overflow || undefined
                            }
                            className="flex min-w-0 shrink overflow-x-auto scrollbar-hidden items-end"
                            style={{
                                gap: tabLayout.stripGap,
                                padding: `0 ${tabLayout.stripPaddingX}px`,
                            }}
                            onWheel={(event) => {
                                if (event.deltaY !== 0) {
                                    event.currentTarget.scrollLeft +=
                                        event.deltaY;
                                    event.preventDefault();
                                }
                            }}
                        >
                            {insertionIndicatorIndex === 0 && (
                                <div
                                    aria-hidden="true"
                                    className="shrink-0 rounded-full"
                                    style={{
                                        width: 3,
                                        height: 20,
                                        backgroundColor: "var(--accent)",
                                        boxShadow:
                                            "0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)",
                                    }}
                                />
                            )}
                            {visualTabs.map((tab, index) => {
                                const isActive = tab.id === pane.activeTabId;
                                const isDragging = tab.id === draggingTabId;
                                const isEditing = editingKey === tab.id;
                                const tabLabel = getTabLabel(
                                    tab,
                                    fileTreeShowExtensions,
                                    chatSessionsById,
                                );
                                return (
                                    <Fragment key={tab.id}>
                                        <div
                                            ref={(node) =>
                                                registerTabNode(tab.id, node)
                                            }
                                            data-pane-tab-id={tab.id}
                                            role="tab"
                                            tabIndex={0}
                                            aria-selected={isActive}
                                            className="group inline-flex shrink-0 items-center text-left"
                                            onPointerDown={(event) =>
                                                isEditing
                                                    ? undefined
                                                    : handlePointerDown(
                                                          tab.id,
                                                          index,
                                                          event,
                                                      )
                                            }
                                            onPointerMove={(event) =>
                                                isEditing
                                                    ? undefined
                                                    : handlePointerMove(
                                                          tab.id,
                                                          event,
                                                      )
                                            }
                                            onPointerUp={(event) =>
                                                isEditing
                                                    ? undefined
                                                    : handlePointerUp(
                                                          event.pointerId,
                                                          {
                                                              clientX:
                                                                  event.clientX,
                                                              clientY:
                                                                  event.clientY,
                                                              screenX:
                                                                  event.screenX,
                                                              screenY:
                                                                  event.screenY,
                                                          },
                                                      )
                                            }
                                            onPointerCancel={(event) =>
                                                isEditing
                                                    ? undefined
                                                    : handlePointerUp(
                                                          event.pointerId,
                                                          {
                                                              clientX:
                                                                  event.clientX,
                                                              clientY:
                                                                  event.clientY,
                                                              screenX:
                                                                  event.screenX,
                                                              screenY:
                                                                  event.screenY,
                                                          },
                                                      )
                                            }
                                            onLostPointerCapture={(event) =>
                                                isEditing
                                                    ? undefined
                                                    : handleLostPointerCapture(
                                                          event.pointerId,
                                                      )
                                            }
                                            onClick={() =>
                                                handleTabClick(tab.id)
                                            }
                                            onContextMenu={(event) => {
                                                if (isEditing) return;
                                                event.preventDefault();
                                                setTabContextMenu({
                                                    x: event.clientX,
                                                    y: event.clientY,
                                                    payload: { tabId: tab.id },
                                                });
                                            }}
                                            style={{
                                                maxWidth: 240,
                                                height: 33,
                                                boxSizing: "border-box",
                                                gap: tabLayout.tabGap,
                                                padding: `0 ${tabLayout.tabPaddingX}px`,
                                                borderRight:
                                                    "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
                                                background: isActive
                                                    ? "var(--bg-primary)"
                                                    : "transparent",
                                                color: isActive
                                                    ? "var(--text-primary)"
                                                    : "var(--text-secondary)",
                                                boxShadow: isActive
                                                    ? "inset 0 -2px 0 0 var(--accent)"
                                                    : "none",
                                                zIndex: isActive ? 10 : 0,
                                                opacity: isDragging ? 0.35 : 1,
                                                cursor: isDragging
                                                    ? "grabbing"
                                                    : "pointer",
                                                transition:
                                                    "background 150ms, color 150ms",
                                            }}
                                        >
                                            {renderEditorTabLeadingIcon(tab)}
                                            {isEditing ? (
                                                <input
                                                    ref={inputRef}
                                                    value={editValue}
                                                    onChange={(event) =>
                                                        setEditValue(
                                                            event.target.value,
                                                        )
                                                    }
                                                    onKeyDown={(event) => {
                                                        if (
                                                            event.key ===
                                                            "Enter"
                                                        ) {
                                                            commitEditing(
                                                                commitChatRename,
                                                            );
                                                        } else if (
                                                            event.key ===
                                                            "Escape"
                                                        ) {
                                                            cancelEditing();
                                                        }
                                                    }}
                                                    onBlur={() =>
                                                        commitEditing(
                                                            commitChatRename,
                                                        )
                                                    }
                                                    onPointerDown={(event) =>
                                                        event.stopPropagation()
                                                    }
                                                    onClick={(event) =>
                                                        event.stopPropagation()
                                                    }
                                                    className="min-w-0 flex-1 truncate bg-transparent font-medium outline-none"
                                                    style={{
                                                        fontSize:
                                                            tabLayout.titleFontSize,
                                                        color: "var(--text-primary)",
                                                        border: "none",
                                                        padding: 0,
                                                        minHeight: 0,
                                                        boxSizing: "border-box",
                                                        boxShadow:
                                                            "inset 0 -1px 0 var(--accent)",
                                                    }}
                                                />
                                            ) : (
                                                <span
                                                    className="min-w-0 flex-1 truncate font-medium"
                                                    style={{
                                                        fontSize:
                                                            tabLayout.titleFontSize,
                                                    }}
                                                >
                                                    {tabLabel}
                                                </span>
                                            )}
                                            <button
                                                type="button"
                                                title={`Close ${tabLabel}`}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    closeTab(tab.id);
                                                }}
                                                className={`ml-0.5 inline-flex shrink-0 items-center justify-center rounded px-0.5 text-[10px] transition ${
                                                    isActive
                                                        ? "opacity-70 hover:opacity-100"
                                                        : "opacity-0 group-hover:opacity-70 hover:opacity-100"
                                                }`}
                                                style={{
                                                    color: "var(--text-secondary)",
                                                }}
                                            >
                                                ×
                                            </button>
                                        </div>
                                        {insertionIndicatorIndex ===
                                            index + 1 && (
                                            <div
                                                aria-hidden="true"
                                                className="shrink-0 rounded-full"
                                                style={{
                                                    width: 3,
                                                    height: 20,
                                                    backgroundColor:
                                                        "var(--accent)",
                                                    boxShadow:
                                                        "0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)",
                                                }}
                                            />
                                        )}
                                    </Fragment>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="flex min-w-0 flex-1 items-center px-3">
                            <span
                                className="truncate text-xs font-medium"
                                style={{
                                    color: "var(--text-secondary)",
                                    opacity: 0.6,
                                }}
                            >
                                No tabs open
                            </span>
                        </div>
                    )}
                </div>

                <div
                    className="flex shrink-0 items-center px-1.5"
                    style={chromeControlsGroupStyle}
                >
                    {vaultPath && (
                        <button
                            type="button"
                            data-new-tab-button="true"
                            onClick={() =>
                                openBlankDraftTabFromPlusButton(paneId)
                            }
                            onContextMenu={(event) => {
                                event.preventDefault();
                                setNewTabContextMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    payload: undefined,
                                });
                            }}
                            className="inline-flex shrink-0 items-center justify-center"
                            aria-label="New tab"
                            title="New tab"
                            style={getPaneHeaderActionButtonStyle()}
                        >
                            <svg
                                width="10"
                                height="10"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
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
                        className="inline-flex shrink-0 items-center justify-center"
                        aria-label={`${paneLabel} actions`}
                        title={`${paneLabel} actions`}
                        style={getPaneHeaderActionButtonStyle()}
                    >
                        <svg
                            width="10"
                            height="10"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                        >
                            <circle cx="8" cy="3.5" r="1.25" />
                            <circle cx="8" cy="8" r="1.25" />
                            <circle cx="8" cy="12.5" r="1.25" />
                        </svg>
                    </button>
                </div>
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

                        if (isChatTab(targetTab)) {
                            entries.push({
                                label: "Rename chat",
                                action: () => beginChatRename(targetTab),
                            });
                        }

                        entries.push({ type: "separator" });
                        entries.push({
                            label: "Move to New Right Split",
                            disabled: !canCreateSplit,
                            action: () => {
                                moveTabToNewSplit(targetTab.id, "row");
                            },
                        });
                        entries.push({
                            label: "Move to New Down Split",
                            disabled: !canCreateSplit,
                            action: () => {
                                moveTabToNewSplit(targetTab.id, "column");
                            },
                        });

                        return entries;
                    })()}
                />
            )}

            {newTabContextMenu && (
                <ContextMenu
                    menu={newTabContextMenu}
                    onClose={() => setNewTabContextMenu(null)}
                    entries={buildNewTabContextMenuEntries({
                        paneId,
                        developerModeEnabled,
                    })}
                />
            )}

            {paneContextMenu && (
                <ContextMenu
                    menu={paneContextMenu}
                    onClose={() => setPaneContextMenu(null)}
                    entries={[
                        {
                            label: "Split Right",
                            action: () => splitEditorPane("row", paneId),
                            disabled: !canCreateSplit,
                        },
                        {
                            label: "Split Down",
                            action: () => splitEditorPane("column", paneId),
                            disabled: !canCreateSplit,
                        },
                        { type: "separator" },
                        {
                            label: "Focus Pane Left",
                            action: () => focusPaneNeighbor("left", paneId),
                            disabled: !leftNeighborPaneId,
                        },
                        {
                            label: "Focus Pane Right",
                            action: () => focusPaneNeighbor("right", paneId),
                            disabled: !rightNeighborPaneId,
                        },
                        {
                            label: "Focus Pane Up",
                            action: () => focusPaneNeighbor("up", paneId),
                            disabled: !upNeighborPaneId,
                        },
                        {
                            label: "Focus Pane Down",
                            action: () => focusPaneNeighbor("down", paneId),
                            disabled: !downNeighborPaneId,
                        },
                        { type: "separator" },
                        {
                            label: "Balance Layout",
                            action: () => balancePaneLayout(),
                            disabled: paneCount <= 1,
                        },
                        {
                            label: "Unify All Tabs",
                            action: () => unifyAllPanesInto(paneId),
                            disabled: paneCount <= 1,
                        },
                        { type: "separator" },
                        {
                            label: `Close Pane ${paneIndex + 1}`,
                            action: () => closePane(paneId),
                            disabled: paneCount <= 1,
                        },
                    ]}
                />
            )}

            {draggedPreviewTab
                ? createPortal(
                      <div
                          ref={dragPreviewNodeRef}
                          data-pane-tab-drag-preview="true"
                          style={{
                              position: "fixed",
                              left: 0,
                              top: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: tabLayout.tabGap,
                              maxWidth: 288,
                              height: 33,
                              padding: `0 ${tabLayout.tabPaddingX}px`,
                              borderRadius: 4,
                              border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                              background: "var(--bg-primary)",
                              color: "var(--text-primary)",
                              boxShadow:
                                  "inset 0 -2px 0 0 var(--accent), 0 10px 24px rgba(15, 23, 42, 0.15)",
                              pointerEvents: "none",
                              zIndex: 9999,
                              willChange: "transform",
                          }}
                      >
                          {renderEditorTabLeadingIcon(draggedPreviewTab)}
                          <span
                              style={{
                                  flex: 1,
                                  minWidth: 0,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  fontSize: tabLayout.titleFontSize,
                                  fontWeight: 600,
                              }}
                          >
                              {getTabLabel(
                                  draggedPreviewTab,
                                  fileTreeShowExtensions,
                                  chatSessionsById,
                              )}
                          </span>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}
