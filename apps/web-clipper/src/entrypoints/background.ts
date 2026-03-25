import { CLIPPER_SOURCE_TAB_QUERY_PARAM } from "../lib/clipper-contract";

const CLIP_WINDOW_PATH = "/clip-window.html";
const CLIP_WINDOW_WIDTH = 1100;
const CLIP_WINDOW_HEIGHT = 760;
const OPEN_CLIPPER_COMMAND = "open-clipper";
const CONTEXT_MENU_ID = "vaultai-save-to-vault";
const CONTEXT_MENU_SIDE_PANEL_ID = "vaultai-open-side-panel";

let clipWindowId: number | null = null;

function buildClipWindowUrl(sourceTabId?: number) {
    const url = new URL(browser.runtime.getURL(CLIP_WINDOW_PATH));

    if (typeof sourceTabId === "number") {
        url.searchParams.set(
            CLIPPER_SOURCE_TAB_QUERY_PARAM,
            String(sourceTabId),
        );
    }

    return url.toString();
}

async function closeExistingClipWindow() {
    if (clipWindowId == null) {
        return;
    }

    try {
        await browser.windows.remove(clipWindowId);
    } catch {
        clipWindowId = null;
    }
}

async function openClipWindow(sourceTabId?: number) {
    await closeExistingClipWindow();

    const clipWindow = await browser.windows.create({
        url: buildClipWindowUrl(sourceTabId),
        type: "popup",
        focused: true,
        width: CLIP_WINDOW_WIDTH,
        height: CLIP_WINDOW_HEIGHT,
    });

    clipWindowId = clipWindow?.id ?? null;
}

async function openClipWindowForActiveTab() {
    const [activeTab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
    });

    await openClipWindow(activeTab?.id);
}

async function initializeContextMenu() {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: "Save to VaultAI",
        contexts: ["page", "selection", "link"],
    });
    browser.contextMenus.create({
        id: CONTEXT_MENU_SIDE_PANEL_ID,
        title: "Open VaultAI Side Panel",
        contexts: ["page", "selection", "link"],
    });
}

async function openSidePanel(tabId?: number) {
    if (typeof tabId !== "number") {
        return;
    }

    const chromeApi = (
        globalThis as unknown as {
            chrome?: {
                sidePanel?: {
                    open(details: { tabId: number }): Promise<void> | void;
                };
            };
        }
    ).chrome;

    if (!chromeApi?.sidePanel?.open) {
        await openClipWindow(tabId);
        return;
    }

    await chromeApi.sidePanel.open({ tabId });
}

export default defineBackground(() => {
    void initializeContextMenu();

    browser.action.onClicked.addListener((tab) => {
        void openClipWindow(tab.id);
    });

    browser.runtime.onInstalled.addListener(() => {
        void initializeContextMenu();
    });

    browser.contextMenus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === CONTEXT_MENU_ID) {
            void openClipWindow(tab?.id);
        } else if (info.menuItemId === CONTEXT_MENU_SIDE_PANEL_ID) {
            void openSidePanel(tab?.id);
        }
    });

    browser.commands.onCommand.addListener((command) => {
        if (command === OPEN_CLIPPER_COMMAND) {
            void openClipWindowForActiveTab();
        }
    });

    browser.windows.onRemoved.addListener((windowId) => {
        if (windowId === clipWindowId) {
            clipWindowId = null;
        }
    });
});
