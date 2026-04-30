import type { TabInput } from "./store/editorStore";
import type { DetachedWindowPayload } from "./detachedWindows";
import type { AIChatSession } from "../features/ai/types";

interface BootstrapDetachedWindowDeps {
    openVault: (path: string) => Promise<void>;
    hydrateTabs: (
        tabs: TabInput[],
        activeTabId: string | null,
        pinnedTabIds?: string[],
        options?: { allowEphemeralTabs?: boolean },
    ) => void;
    hydrateAiSessions?: (
        sessions: AIChatSession[],
        activeTabId: string | null,
        tabs: TabInput[],
    ) => void;
}

export async function bootstrapDetachedWindow(
    payload: DetachedWindowPayload | null,
    { openVault, hydrateTabs, hydrateAiSessions }: BootstrapDetachedWindowDeps,
) {
    if (!payload) return;

    if (payload.vaultPath) {
        try {
            await openVault(payload.vaultPath);
        } catch (error) {
            console.error(
                "Failed to restore vault for detached window:",
                error,
            );
        }
    }

    hydrateAiSessions?.(
        payload.aiSessions ?? [],
        payload.activeTabId,
        payload.tabs,
    );

    hydrateTabs(payload.tabs, payload.activeTabId, payload.pinnedTabIds ?? [], {
        allowEphemeralTabs: true,
    });
}
