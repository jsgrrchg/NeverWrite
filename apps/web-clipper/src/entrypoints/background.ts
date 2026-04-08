import { APP_BRAND_NAME, WEB_CLIPPER_SIDE_PANEL_TITLE } from "../lib/branding";

const CONTEXT_MENU_ID = "neverwrite-save-to-vault";
const CONTEXT_MENU_SIDE_PANEL_ID = "neverwrite-open-side-panel";

async function initializeContextMenu() {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: `Save to ${APP_BRAND_NAME}`,
        contexts: ["page", "selection", "link"],
    });
    browser.contextMenus.create({
        id: CONTEXT_MENU_SIDE_PANEL_ID,
        title: `Open ${WEB_CLIPPER_SIDE_PANEL_TITLE}`,
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
        return;
    }

    await chromeApi.sidePanel.open({ tabId });
}

export default defineBackground(() => {
    void initializeContextMenu();

    browser.runtime.onInstalled.addListener(() => {
        void initializeContextMenu();
    });

    browser.contextMenus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === CONTEXT_MENU_ID) {
            if (typeof browser.action.openPopup === "function") {
                void browser.action.openPopup();
            }
        } else if (info.menuItemId === CONTEXT_MENU_SIDE_PANEL_ID) {
            void openSidePanel(tab?.id);
        }
    });
});
