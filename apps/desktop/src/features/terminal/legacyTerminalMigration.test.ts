import { beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyTerminalTabsToWorkspace } from "./legacyTerminalMigration";

const vaultPath = "/vaults/project";
const legacyStorageKey = `neverwrite.devtools.terminal.tabs:${vaultPath}`;
const migrationKey = `neverwrite.workspace.terminal.legacyMigrated:${vaultPath}`;

describe("legacyTerminalMigration", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("creates workspace terminal tabs from legacy terminal tabs once", () => {
        localStorage.setItem(
            legacyStorageKey,
            JSON.stringify({
                version: 2,
                activeTabId: "legacy-2",
                tabs: [
                    {
                        id: "legacy-1",
                        title: "Server",
                        cwd: "/vaults/project/api",
                        rawOutput: "ignored",
                    },
                    {
                        id: "legacy-2",
                        title: null,
                        cwd: "/vaults/project/web",
                        rawOutput: "also ignored",
                    },
                ],
            }),
        );

        const migrated = migrateLegacyTerminalTabsToWorkspace({
            vaultPath,
            focusedPaneId: "primary",
            panes: [{ id: "primary", tabs: [], activeTabId: null }],
        });

        expect(migrated.migrated).toBe(true);
        expect(localStorage.getItem(migrationKey)).toBe("true");
        expect(migrated.panes[0]?.tabs).toHaveLength(2);
        expect(migrated.panes[0]?.tabs[0]).toMatchObject({
            kind: "terminal",
            title: "Server",
            cwd: "/vaults/project/api",
        });
        expect(migrated.panes[0]?.tabs[1]).toMatchObject({
            kind: "terminal",
            title: "Terminal",
            cwd: "/vaults/project/web",
        });
        expect(migrated.panes[0]?.activeTabId).toBe(
            migrated.panes[0]?.tabs[0]?.id,
        );

        const secondPass = migrateLegacyTerminalTabsToWorkspace({
            vaultPath,
            focusedPaneId: "primary",
            panes: migrated.panes,
        });

        expect(secondPass.migrated).toBe(false);
        expect(secondPass.panes).toBe(migrated.panes);
    });

    it("does not duplicate legacy tabs when workspace terminal tabs already exist", () => {
        localStorage.setItem(
            legacyStorageKey,
            JSON.stringify({
                version: 2,
                activeTabId: "legacy-1",
                tabs: [
                    {
                        id: "legacy-1",
                        title: "Legacy",
                        cwd: "/vaults/project",
                        rawOutput: "",
                    },
                ],
            }),
        );

        const existingTerminal = {
            id: "terminal-tab",
            kind: "terminal" as const,
            terminalId: "terminal-runtime",
            title: "Terminal 1",
            cwd: "/vaults/project",
        };
        const migrated = migrateLegacyTerminalTabsToWorkspace({
            vaultPath,
            focusedPaneId: "primary",
            panes: [
                {
                    id: "primary",
                    tabs: [existingTerminal],
                    activeTabId: existingTerminal.id,
                },
            ],
        });

        expect(migrated.migrated).toBe(false);
        expect(localStorage.getItem(migrationKey)).toBe("true");
        expect(migrated.panes[0]?.tabs).toEqual([existingTerminal]);
    });
});
