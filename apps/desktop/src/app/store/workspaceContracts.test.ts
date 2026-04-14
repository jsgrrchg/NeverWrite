import { describe, expect, it } from "vitest";
import {
    WORKSPACE_PHASE0_INCONSISTENCIES,
    WORKSPACE_PHASE0_INVENTORY,
    WORKSPACE_PHASE0_STATE_FIELDS,
} from "./workspaceContracts";

describe("workspaceContracts Phase 0 inventory", () => {
    it("documents the ownership hotspots called out by the migration plan", () => {
        const inventoryIds = new Set(
            WORKSPACE_PHASE0_INVENTORY.map((entry) => entry.id),
        );

        expect(inventoryIds.has("editor-store-hybrid-ownership")).toBe(true);
        expect(
            inventoryIds.has("editor-store-focused-pane-projection-bridge"),
        ).toBe(true);
        expect(inventoryIds.has("unified-bar-global-tab-strip")).toBe(true);
        expect(inventoryIds.has("editor-pane-bar-pane-tab-strip")).toBe(true);
        expect(inventoryIds.has("ai-chat-panel-sidebar-primary-surface")).toBe(
            true,
        );
        expect(inventoryIds.has("chat-tabs-session-metadata-store")).toBe(true);
    });

    it("keeps every inventory field reference inside the declared Phase 0 state surface", () => {
        const knownFields = new Set(WORKSPACE_PHASE0_STATE_FIELDS);

        for (const entry of WORKSPACE_PHASE0_INVENTORY) {
            for (const field of [...entry.reads, ...entry.writes]) {
                expect(knownFields.has(field)).toBe(true);
            }
        }
    });

    it("calls out the key architectural inconsistencies that must be removed later", () => {
        const inconsistencyIds = new Set(
            WORKSPACE_PHASE0_INCONSISTENCIES.map((entry) => entry.id),
        );

        expect(inconsistencyIds.has("duplicate-tab-reorder-paths")).toBe(true);
        expect(
            inconsistencyIds.has(
                "focused-pane-projection-keeps-legacy-model-alive",
            ),
        ).toBe(true);
        expect(
            inconsistencyIds.has(
                "global-navigation-still-lives-in-window-chrome",
            ),
        ).toBe(true);
    });
});
