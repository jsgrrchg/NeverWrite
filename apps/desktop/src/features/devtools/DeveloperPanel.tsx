import { useCallback, useEffect, useMemo } from "react";
import { useLayoutStore } from "../../app/store/layoutStore";
import {
    DeveloperPanelHeader,
    type DeveloperPanelTabItem,
} from "./DeveloperPanelHeader";
import { TerminalViewport } from "./terminal/TerminalViewport";
import { useTerminalTabs } from "./terminal/useTerminalTabs";

export const DEVELOPER_PANEL_RESTART_EVENT = "vaultai:developer-panel:restart";
export const DEVELOPER_PANEL_NEW_TAB_EVENT = "vaultai:developer-panel:new-tab";

const FALLBACK_TERMINAL_LABEL = "Terminal";

function buildTerminalTabs(
    workspace: ReturnType<typeof useTerminalTabs>,
): DeveloperPanelTabItem[] {
    const counts = new Map<string, number>();

    for (const tab of workspace.tabs) {
        const baseLabel =
            tab.customTitle?.trim() ||
            tab.snapshot.displayName?.trim() ||
            FALLBACK_TERMINAL_LABEL;
        counts.set(baseLabel, (counts.get(baseLabel) ?? 0) + 1);
    }

    const seen = new Map<string, number>();

    return workspace.tabs.map((tab) => {
        const baseLabel =
            tab.customTitle?.trim() ||
            tab.snapshot.displayName?.trim() ||
            FALLBACK_TERMINAL_LABEL;
        const ordinal = (seen.get(baseLabel) ?? 0) + 1;
        seen.set(baseLabel, ordinal);

        const title =
            !tab.customTitle && (counts.get(baseLabel) ?? 0) > 1
                ? `${baseLabel} ${ordinal}`
                : baseLabel;

        return {
            id: tab.id,
            title,
            status: tab.snapshot.status,
            hasCustomTitle: Boolean(tab.customTitle),
            isActive: tab.id === workspace.activeTabId,
        };
    });
}

export function DeveloperPanel() {
    const toggleBottomPanel = useLayoutStore(
        (state) => state.toggleBottomPanel,
    );
    const workspace = useTerminalTabs(true);
    const activeTab = workspace.activeTab;
    const openTab = workspace.openTab;
    const restartActiveTab = workspace.restartActiveTab;

    useEffect(() => {
        const handleRestart = () => {
            void restartActiveTab();
        };

        const handleNewTab = () => {
            void openTab();
        };

        window.addEventListener(DEVELOPER_PANEL_RESTART_EVENT, handleRestart);
        window.addEventListener(DEVELOPER_PANEL_NEW_TAB_EVENT, handleNewTab);

        return () => {
            window.removeEventListener(
                DEVELOPER_PANEL_RESTART_EVENT,
                handleRestart,
            );
            window.removeEventListener(
                DEVELOPER_PANEL_NEW_TAB_EVENT,
                handleNewTab,
            );
        };
    }, [openTab, restartActiveTab]);

    const activeId = activeTab?.id ?? null;
    const writeToTab = workspace.writeToTab;
    const resizeTab = workspace.resizeTab;
    const restartTabFn = workspace.restartTab;
    const clearTab = workspace.clearTab;

    const writeInput = useCallback(
        (input: string) => {
            if (activeId) return writeToTab(activeId, input);
            return Promise.resolve();
        },
        [activeId, writeToTab],
    );

    const resize = useCallback(
        (cols: number, rows: number) => {
            if (activeId) return resizeTab(activeId, cols, rows);
            return Promise.resolve();
        },
        [activeId, resizeTab],
    );

    const restart = useCallback(() => {
        if (activeId) return restartTabFn(activeId);
        return Promise.resolve();
    }, [activeId, restartTabFn]);

    const clearViewport = useCallback(() => {
        if (activeId) clearTab(activeId);
    }, [activeId, clearTab]);

    const session = useMemo(
        () =>
            activeTab
                ? {
                      snapshot: activeTab.snapshot,
                      rawOutput: activeTab.rawOutput,
                      busy: activeTab.busy,
                      writeInput,
                      resize,
                      restart,
                      clearViewport,
                  }
                : null,
        [activeTab, writeInput, resize, restart, clearViewport],
    );

    const tabs = buildTerminalTabs(workspace);

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <DeveloperPanelHeader
                tabs={tabs}
                activeTabId={workspace.activeTabId}
                canClear={(activeTab?.rawOutput.length ?? 0) > 0}
                onClear={workspace.clearActiveTab}
                onNewTab={() => void workspace.openTab()}
                onSelectTab={workspace.selectTab}
                onRenameTab={workspace.renameTab}
                onDuplicateTab={(tabId) => void workspace.duplicateTab(tabId)}
                onResetTabTitle={workspace.resetTabTitle}
                onReorderTabs={workspace.reorderTabs}
                onCloseOthers={(tabId) => void workspace.closeOtherTabs(tabId)}
                onCloseTab={(tabId) => void workspace.closeTab(tabId)}
                onRestart={() => void workspace.restartActiveTab()}
                onRestartTab={(tabId) => void workspace.restartTab(tabId)}
                onHide={toggleBottomPanel}
            />
            <div className="min-h-0 flex-1">
                {session ? (
                    <TerminalViewport session={session} />
                ) : (
                    <div
                        className="flex h-full items-center justify-center text-xs"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {activeTab
                            ? `session: ${activeTab.sessionId ?? "null"} | status: ${activeTab.snapshot.status} | busy: ${activeTab.busy}`
                            : `No active tab (tabs: ${workspace.tabs.length}, activeId: ${workspace.activeTabId})`}
                    </div>
                )}
            </div>
        </div>
    );
}
