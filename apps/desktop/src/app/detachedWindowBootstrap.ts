import type { TabInput } from "./store/editorStore";
import type { DetachedWindowPayload } from "./detachedWindows";

interface BootstrapDetachedWindowDeps {
    openVault: (path: string) => Promise<void>;
    hydrateTabs: (
        tabs: TabInput[],
        activeTabId: string | null,
        pinnedTabIds?: string[],
    ) => void;
}

export async function bootstrapDetachedWindow(
    payload: DetachedWindowPayload | null,
    { openVault, hydrateTabs }: BootstrapDetachedWindowDeps,
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

    hydrateTabs(payload.tabs, payload.activeTabId, payload.pinnedTabIds ?? []);
}
