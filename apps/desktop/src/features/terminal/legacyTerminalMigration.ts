import {
    createTerminalTab,
    isTerminalTab,
    type TabInput,
} from "../../app/store/editorTabs";
import type { EditorPaneInput } from "../../app/store/editorWorkspace";
import {
    safeStorageGetItem,
    safeStorageSetItem,
} from "../../app/utils/safeStorage";
import { readPersistedTerminalWorkspace } from "../devtools/terminal/useTerminalTabs";

const LEGACY_TERMINAL_MIGRATION_KEY_PREFIX =
    "neverwrite.workspace.terminal.legacyMigrated:";

function getLegacyTerminalMigrationKey(vaultPath: string) {
    return `${LEGACY_TERMINAL_MIGRATION_KEY_PREFIX}${vaultPath}`;
}

function workspaceHasTerminalTabs(panes: readonly EditorPaneInput[]) {
    return panes.some((pane) => pane.tabs.some((tab) => isTerminalTab(tab)));
}

function appendTabsToPane(
    pane: EditorPaneInput,
    tabs: TabInput[],
): EditorPaneInput {
    const activeTabId = pane.activeTabId ?? tabs[0]?.id ?? null;
    const tabIds = new Set(pane.tabs.map((tab) => tab.id));
    const nextActivationHistory = [
        ...(pane.activationHistory ?? []).filter((id) => tabIds.has(id)),
    ];
    const nextNavigationHistory = [
        ...(pane.tabNavigationHistory ?? []).filter((id) => tabIds.has(id)),
    ];

    if (activeTabId && !nextActivationHistory.includes(activeTabId)) {
        nextActivationHistory.push(activeTabId);
    }
    if (activeTabId && !nextNavigationHistory.includes(activeTabId)) {
        nextNavigationHistory.push(activeTabId);
    }

    return {
        ...pane,
        tabs: [...pane.tabs, ...tabs],
        activeTabId,
        activationHistory: nextActivationHistory,
        tabNavigationHistory: nextNavigationHistory,
        tabNavigationIndex: activeTabId
            ? Math.max(0, nextNavigationHistory.lastIndexOf(activeTabId))
            : -1,
    };
}

export function migrateLegacyTerminalTabsToWorkspace(args: {
    vaultPath: string | null;
    panes: EditorPaneInput[];
    focusedPaneId?: string | null;
}): { panes: EditorPaneInput[]; migrated: boolean } {
    const vaultPath = args.vaultPath;
    if (!vaultPath) {
        return { panes: args.panes, migrated: false };
    }

    const migrationKey = getLegacyTerminalMigrationKey(vaultPath);
    if (safeStorageGetItem(migrationKey) === "true") {
        return { panes: args.panes, migrated: false };
    }

    const hasWorkspaceTerminalTabs = workspaceHasTerminalTabs(args.panes);
    const legacyWorkspace = readPersistedTerminalWorkspace(vaultPath);
    safeStorageSetItem(migrationKey, "true");

    if (hasWorkspaceTerminalTabs || !legacyWorkspace?.tabs.length) {
        return { panes: args.panes, migrated: false };
    }

    const terminalTabs = legacyWorkspace.tabs.map((tab) =>
        createTerminalTab({
            title: tab.title,
            cwd: tab.cwd,
        }),
    );
    const targetPaneId =
        args.focusedPaneId &&
        args.panes.some((pane) => pane.id === args.focusedPaneId)
            ? args.focusedPaneId
            : (args.panes[0]?.id ?? "primary");
    const panes =
        args.panes.length > 0
            ? args.panes
            : [{ id: targetPaneId, tabs: [], activeTabId: null }];

    return {
        migrated: true,
        panes: panes.map((pane) =>
            pane.id === targetPaneId
                ? appendTabsToPane(pane, terminalTabs)
                : pane,
        ),
    };
}
