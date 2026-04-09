import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "../../app/store/editorStore";
import { openVaultEmbedTarget } from "./embedNavigation";
import { setEditorTabs, setVaultEntries } from "../../test/test-utils";

vi.mock("@tauri-apps/plugin-opener", () => ({
    openPath: vi.fn(),
}));

describe("embedNavigation", () => {
    beforeEach(() => {
        setEditorTabs([]);
        setVaultEntries(
            [
                {
                    id: "papers/deepseek-r1",
                    kind: "pdf",
                    path: "/vault/RESEARCH/2026/Papers/2025 - DeepSeek-R1 Reasoning via RL [DeepSeek].pdf",
                    relative_path:
                        "RESEARCH/2026/Papers/2025 - DeepSeek-R1 Reasoning via RL [DeepSeek].pdf",
                    title: "DeepSeek R1",
                    file_name:
                        "2025 - DeepSeek-R1 Reasoning via RL [DeepSeek].pdf",
                    extension: "pdf",
                    modified_at: 0,
                    created_at: 0,
                    size: 0,
                    mime_type: "application/pdf",
                },
            ],
            "/vault",
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("opens vault pdf embeds in the in-app pdf tab", async () => {
        await openVaultEmbedTarget(
            "/RESEARCH/2026/Papers/2025 - DeepSeek-R1 Reasoning via RL [DeepSeek].pdf",
            "pdf",
        );

        const activeTab = useEditorStore
            .getState()
            .tabs.find(
                (tab) => tab.id === useEditorStore.getState().activeTabId,
            );

        expect(activeTab).toMatchObject({
            kind: "pdf",
            entryId: "papers/deepseek-r1",
            title: "DeepSeek R1",
            path: "/vault/RESEARCH/2026/Papers/2025 - DeepSeek-R1 Reasoning via RL [DeepSeek].pdf",
        });
    });
});
