import {
    type CSSProperties,
    Fragment,
    useCallback,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { createPortal } from "react-dom";
import { confirm } from "@neverwrite/runtime";
import {
    type Tab,
    type TerminalTab,
    isChatTab,
    isFileTab,
    isNoteTab,
    isPdfTab,
    isTerminalTab,
    selectEditorPaneState,
    selectEditorWorkspaceTabs,
    selectLeafPaneIds,
    selectPaneCount,
    useEditorStore,
} from "../../app/store/editorStore";
import { getSessionTitle } from "../ai/sessionPresentation";
import { useChatStore } from "../ai/store/chatStore";
import { useInlineRename } from "../ai/components/useInlineRename";
import { isSearchTab, SEARCH_TAB_TITLE } from "../search/searchTab";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { getWindowMode } from "../../app/detachedWindows";
import { buildNewTabContextMenuEntries } from "./newTabMenuActions";
import { useCommandStore } from "../command-palette/store/commandStore";
import { createWorkspaceTabExternalDragHandlers } from "./tabDragAttachments";
import { renderEditorTabActivityIndicator } from "./EditorTabActivityIndicator";
import { renderEditorTabLeadingIcon } from "./editorTabIcons";
import { useResponsiveEditorTabLayout } from "./editorTabStripLayout";
import { useActiveTabStripReveal } from "./tabStrip";
import { useWorkspaceTabDrag } from "./useWorkspaceTabDrag";
import { useDetachedTabWindowDrop } from "./useDetachedTabWindowDrop";
import {
    findActiveSessionsAffectedByClose,
    getCloseTabsConfirmationMessage,
} from "./tabClosePolicy";
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

    if (isSearchTab(tab)) {
        return SEARCH_TAB_TITLE;
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

// 1px hairline that sits between the "new tab" and "pane actions" buttons in
// the pane header, replacing the old pill container with a flat divider.
const paneHeaderActionDividerStyle: CSSProperties = {
    width: 1,
    height: 12,
    margin: "0 4px",
    backgroundColor: "var(--border)",
    flexShrink: 0,
};

function getDuplicateTerminalTitle(tab: TerminalTab) {
    const title = tab.title.trim();
    if (!title || /^Terminal(?: \d+)?$/.test(title)) {
        return null;
    }
    return `${title} copy`;
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
    const togglePaneTabPinned = useEditorStore(
        (state) => state.togglePaneTabPinned,
    );
    const goBack = useEditorStore((state) => state.goBack);
    const goForward = useEditorStore((state) => state.goForward);
    const closePane = useEditorStore((state) => state.closePane);
    const togglePaneTabDisplayMode = useEditorStore(
        (state) => state.togglePaneTabDisplayMode,
    );
    const isStackedTabs = pane.tabDisplayMode === "stacked";
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
    const pinnedTabIdSet = new Set(pane.pinnedTabIds);
    const paneLabel = `Pane ${paneIndex + 1}`;
    const activePaneTab =
        pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
    const showHistoryNavigationButtons = tabOpenBehavior === "history";
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
    const externalTabDrag = createWorkspaceTabExternalDragHandlers({
        getTabById: (tabId) =>
            pane.tabs.find((candidate) => candidate.id === tabId) ?? null,
        resolveDetachDropTarget: detachedTabWindowDrop.resolveDetachDropTarget,
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
        resolveExternalDropTarget: externalTabDrag.resolveExternalDropTarget,
        onCommitExternalDrop: (tabId, target, coords) => {
            if (target.type !== "detach-window") {
                return;
            }

            return detachedTabWindowDrop.commitDetachDrop(tabId, coords);
        },
        onDetachStart: detachedTabWindowDrop.handleDetachStart,
        onDetachMove: detachedTabWindowDrop.handleDetachMove,
        onDetachCancel: detachedTabWindowDrop.handleDetachCancel,
        buildAttachmentDetail: externalTabDrag.buildAttachmentDetail,
    });
    const tabLayout = useResponsiveEditorTabLayout({
        stripRef: tabStripRef,
        tabCount: visualTabs.length,
        freeze: draggingTabId !== null,
        sizingMode: "fixed",
    });
    const tabOrderKey = visualTabs.map((tab) => tab.id).join("|");
    useActiveTabStripReveal({
        stripRef: tabStripRef,
        activeTabId: pane.activeTabId,
        draggingTabId,
        tabOrderKey,
        tabIdAttribute: "data-pane-tab-id",
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

    // Absolutely-positioned indicator ref — avoids flex layout shifts
    // during drag that cause visible tab jitter.
    const insertionIndicatorRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const indicator = insertionIndicatorRef.current;
        if (!indicator) return;

        if (insertionIndicatorIndex === null) {
            indicator.style.display = "none";
            return;
        }

        const strip = tabStripRef.current;
        if (!strip) {
            indicator.style.display = "none";
            return;
        }

        const tabNodes = Array.from(
            strip.querySelectorAll<HTMLElement>("[data-pane-tab-id]"),
        );

        if (tabNodes.length === 0) {
            indicator.style.display = "none";
            return;
        }

        let left: number;
        if (insertionIndicatorIndex < tabNodes.length) {
            left = tabNodes[insertionIndicatorIndex].offsetLeft;
        } else {
            const last = tabNodes[tabNodes.length - 1];
            left = last.offsetLeft + last.offsetWidth;
        }

        indicator.style.display = "";
        indicator.style.transform = `translate(${left - 1}px, -50%)`;
    }, [insertionIndicatorIndex, tabStripRef]);

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
    const beginTerminalRename = useCallback(
        (tab: Tab) => {
            if (!isTerminalTab(tab)) return;
            switchTab(tab.id);
            startEditing(tab.id, tab.title);
        },
        [startEditing, switchTab],
    );
    const commitTabRename = useCallback(
        (tabId: string, value: string | null) => {
            const tab = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            ).find((candidate) => candidate.id === tabId);
            if (!tab) return;

            if (isChatTab(tab)) {
                renameChatSession(tab.sessionId, value);
                return;
            }

            if (isTerminalTab(tab)) {
                useEditorStore
                    .getState()
                    .updateTabTitle(tab.id, value?.trim() || "Terminal");
            }
        },
        [renameChatSession],
    );
    const requestCloseTab = useCallback(
        async (tabId: string) => {
            const tab = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            ).find((candidate) => candidate.id === tabId);
            if (!tab) {
                return;
            }

            const affected = findActiveSessionsAffectedByClose(
                [tab],
                useChatStore.getState().sessionsById,
            );
            const confirmationMessage =
                getCloseTabsConfirmationMessage(affected);
            if (
                confirmationMessage !== null &&
                !(await confirm(confirmationMessage))
            ) {
                return;
            }

            closeTab(tab.id);
        },
        [closeTab],
    );
    const closeTabIdsWithProtection = useCallback(async (tabIds: string[]) => {
        const currentTabs = selectEditorWorkspaceTabs(useEditorStore.getState());
        const tabsToClose = tabIds
            .map(
                (tabId) =>
                    currentTabs.find((candidate) => candidate.id === tabId) ??
                    null,
            )
            .filter((tab): tab is (typeof currentTabs)[number] => tab !== null);

        if (tabsToClose.length === 0) {
            return;
        }

        const affected = findActiveSessionsAffectedByClose(
            tabsToClose,
            useChatStore.getState().sessionsById,
        );
        const confirmationMessage =
            getCloseTabsConfirmationMessage(affected);
        if (
            confirmationMessage !== null &&
            !(await confirm(confirmationMessage))
        ) {
            return;
        }

        for (const tabId of tabIds) {
            useEditorStore.getState().closeTab(tabId, {
                reason: "bulk-user",
            });
        }
    }, []);
    const closeOtherTabsInPane = useCallback(
        async (tabId: string) => {
            const currentPane = selectEditorPaneState(
                useEditorStore.getState(),
                paneId,
            );
            const tabIds = currentPane.tabs
                .filter((tab) => tab.id !== tabId)
                .map((tab) => tab.id);

            await closeTabIdsWithProtection(tabIds);
        },
        [closeTabIdsWithProtection, paneId],
    );
    const closeTabsToTheRightInPane = useCallback(
        async (tabId: string) => {
            const currentPane = selectEditorPaneState(
                useEditorStore.getState(),
                paneId,
            );
            const tabIndex = currentPane.tabs.findIndex(
                (tab) => tab.id === tabId,
            );
            if (tabIndex === -1) {
                return;
            }

            const tabIds = currentPane.tabs
                .slice(tabIndex + 1)
                .map((tab) => tab.id)
                .reverse();

            await closeTabIdsWithProtection(tabIds);
        },
        [closeTabIdsWithProtection, paneId],
    );

    return (
        <>
            <div
                className="drag flex items-center shrink-0"
                style={{
                    height: 33,
                    minHeight: 33,
                    boxSizing: "border-box",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg-secondary)",
                }}
                data-pane-empty={hasTabs ? undefined : "true"}
            >
                {showHistoryNavigationButtons && (
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
                )}

                <div className="relative flex min-w-0 flex-1 self-stretch overflow-hidden">
                    {hasTabs ? (
                        isStackedTabs ? (
                            <div className="flex min-w-0 flex-1 items-center px-3">
                                <span
                                    className="truncate text-xs font-medium"
                                    style={{
                                        color: "var(--text-secondary)",
                                        opacity: 0.7,
                                    }}
                                >
                                    Stacked tabs
                                </span>
                            </div>
                        ) : (
                        <div
                            ref={tabStripRef}
                            data-pane-tab-strip={paneId}
                            data-pane-tab-density={tabLayout.density}
                            data-pane-tab-overflowing={
                                tabLayout.overflow || undefined
                            }
                            className="relative flex min-w-0 shrink overflow-x-auto scrollbar-hidden items-end"
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
                            {visualTabs.map((tab, index) => {
                                const isActive = tab.id === pane.activeTabId;
                                const isDragging = tab.id === draggingTabId;
                                const isEditing = editingKey === tab.id;
                                const isPinned = pinnedTabIdSet.has(tab.id);
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
                                            data-pane-tab-pinned={
                                                isPinned ? "true" : undefined
                                            }
                                            role="tab"
                                            tabIndex={0}
                                            aria-selected={isActive}
                                            aria-label={tabLabel}
                                            title={
                                                isPinned ? tabLabel : undefined
                                            }
                                            className="no-drag group inline-flex shrink-0 items-center text-left"
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
                                                width: isPinned
                                                    ? 34
                                                    : tabLayout.tabWidth,
                                                minWidth: isPinned
                                                    ? 34
                                                    : tabLayout.tabWidth,
                                                maxWidth: isPinned ? 34 : 240,
                                                height: 33,
                                                flexShrink: 0,
                                                justifyContent: isPinned
                                                    ? "center"
                                                    : undefined,
                                                boxSizing: "border-box",
                                                gap: isPinned
                                                    ? 0
                                                    : tabLayout.tabGap,
                                                padding: isPinned
                                                    ? 0
                                                    : `0 ${tabLayout.tabPaddingX}px`,
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
                                            {renderEditorTabLeadingIcon(
                                                tab,
                                                chatSessionsById,
                                            )}
                                            {renderEditorTabActivityIndicator(
                                                tab,
                                                chatSessionsById,
                                            )}
                                            {isPinned ? null : isEditing ? (
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
                                                                commitTabRename,
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
                                                            commitTabRename,
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
                                            {isPinned ? null : (
                                                <button
                                                    type="button"
                                                    title={`Close ${tabLabel}`}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        void requestCloseTab(
                                                            tab.id,
                                                        );
                                                    }}
                                                    className={`ml-0.5 inline-flex shrink-0 items-center justify-center rounded-md transition-[background-color,opacity,transform] duration-150 ease-out hover:bg-gray-500/30 active:bg-gray-500/55 active:scale-90 ${
                                                        isActive
                                                            ? "opacity-70 hover:opacity-100"
                                                            : "opacity-0 group-hover:opacity-65 hover:opacity-100"
                                                    }`}
                                                    style={{
                                                        width: 20,
                                                        height: 20,
                                                        color: "var(--text-secondary)",
                                                        // Match UnifiedBar tab close: sit closer to the
                                                        // right edge of the tab.
                                                        marginRight: -6,
                                                    }}
                                                >
                                                    <svg
                                                        width={13}
                                                        height={13}
                                                        viewBox="0 0 16 16"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2.1"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                    >
                                                        <path d="M4 4l8 8M4 12l8-8" />
                                                    </svg>
                                                </button>
                                            )}
                                        </div>
                                    </Fragment>
                                );
                            })}
                            <div
                                ref={insertionIndicatorRef}
                                aria-hidden="true"
                                className="rounded-full"
                                style={{
                                    position: "absolute",
                                    top: "50%",
                                    left: 0,
                                    width: 3,
                                    height: 20,
                                    backgroundColor: "var(--accent)",
                                    boxShadow:
                                        "0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)",
                                    pointerEvents: "none",
                                    zIndex: 20,
                                    display: "none",
                                }}
                            />
                        </div>
                        )
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

                <div className="flex shrink-0 items-center px-1.5">
                    {vaultPath && (
                        <Fragment>
                            <button
                                type="button"
                                data-new-tab-button="true"
                                onClick={() =>
                                    useCommandStore
                                        .getState()
                                        .openQuickSwitcher()
                                }
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    setNewTabContextMenu({
                                        x: event.clientX,
                                        y: event.clientY,
                                        payload: undefined,
                                    });
                                }}
                                className="ub-chrome-btn inline-flex shrink-0 items-center justify-center"
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
                            {/* Thin vertical divider between the pane action
                                buttons; the group reads flat, with no
                                surrounding pill. */}
                            <span
                                aria-hidden="true"
                                style={paneHeaderActionDividerStyle}
                            />
                        </Fragment>
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
                        className="ub-chrome-btn inline-flex shrink-0 items-center justify-center"
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
                        const targetTabPinned = pinnedTabIdSet.has(
                            targetTab.id,
                        );
                        const targetTabIndex = pane.tabs.findIndex(
                            (candidate) => candidate.id === targetTab.id,
                        );

                        const entries: ContextMenuEntry[] = [
                            {
                                label: targetTabPinned ? "Unpin Tab" : "Pin Tab",
                                action: () =>
                                    togglePaneTabPinned(paneId, targetTab.id),
                            },
                            {
                                label: "Close",
                                action: () =>
                                    void requestCloseTab(targetTab.id),
                            },
                            {
                                label: "Close Others",
                                disabled: pane.tabs.length <= 1,
                                action: () =>
                                    void closeOtherTabsInPane(targetTab.id),
                            },
                            {
                                label: "Close Tabs to the Right",
                                disabled:
                                    targetTabIndex === -1 ||
                                    targetTabIndex >= pane.tabs.length - 1,
                                action: () =>
                                    void closeTabsToTheRightInPane(
                                        targetTab.id,
                                    ),
                            },
                        ];

                        if (!targetTabPinned && isChatTab(targetTab)) {
                            entries.push({
                                label: "Rename chat",
                                action: () => beginChatRename(targetTab),
                            });
                        }

                        if (isTerminalTab(targetTab)) {
                            entries.push({
                                label: "Restart Terminal",
                                action: () => {
                                    void useTerminalRuntimeStore
                                        .getState()
                                        .restart(targetTab.terminalId);
                                },
                            });
                            entries.push({
                                label: "Clear Terminal",
                                action: () => {
                                    useTerminalRuntimeStore
                                        .getState()
                                        .clear(targetTab.terminalId);
                                },
                            });
                            entries.push({
                                label: "Duplicate Terminal",
                                action: () => {
                                    useEditorStore.getState().openTerminal({
                                        paneId,
                                        cwd: targetTab.cwd,
                                        title: getDuplicateTerminalTitle(
                                            targetTab,
                                        ),
                                    });
                                },
                            });
                            if (!targetTabPinned) {
                                entries.push({
                                    label: "Rename Terminal",
                                    action: () =>
                                        beginTerminalRename(targetTab),
                                });
                            }
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
                    entries={buildNewTabContextMenuEntries({ paneId })}
                />
            )}

            {paneContextMenu && (
                <ContextMenu
                    menu={paneContextMenu}
                    onClose={() => setPaneContextMenu(null)}
                    entries={[
                        {
                            label: isStackedTabs
                                ? "Unstack tabs"
                                : "Stack tabs",
                            action: () => togglePaneTabDisplayMode(paneId),
                            disabled: !hasTabs,
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
                          {renderEditorTabLeadingIcon(
                              draggedPreviewTab,
                              chatSessionsById,
                          )}
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
