import {
    app,
    BrowserWindow,
    Menu,
    type MenuItemConstructorOptions,
} from "electron";
import { ELECTRON_IPC } from "../shared/ipc";
import {
    createAppWindow,
    getWindowByLabel,
    getWindowLabel,
} from "./window";
import {
    getRecentVaultsSnapshot,
    getWindowVaultRoute,
    loadRecentVaults,
    selectMainWindowRouteLabel,
    syncRecentVaults,
} from "./shellState";

const MENU_ACTION_EVENT = "menu-action";
const DOCK_OPEN_VAULT_EVENT = "dock-open-vault";

const nativeMenuCommands = new Set([
    "app:open-settings",
    "vault:new-note",
    "editor:new-tab",
    "vault:open",
    "editor:close-tab",
    "editor:reopen-closed-tab",
    "editor:save-active-note",
    "editor:search-in-note",
    "vault:search",
    "editor:bold-selection",
    "editor:highlight-selection",
    "editor:heading-1",
    "editor:heading-2",
    "editor:heading-3",
    "editor:heading-4",
    "editor:heading-5",
    "editor:heading-6",
    "editor:heading-0",
    "editor:toggle-live-preview",
    "workspace:new-terminal-tab",
    "layout:toggle-sidebar",
    "layout:toggle-right-panel",
    "nav:command-palette",
    "nav:quick-switcher",
    "app:zoom-in",
    "app:zoom-out",
    "app:zoom-reset",
    "nav:back",
    "nav:forward",
    "nav:next-tab",
    "nav:previous-tab",
]);

const configurableNativeMenuCommands = new Set([
    "app:open-settings",
    "vault:new-note",
    "editor:new-tab",
    "workspace:new-terminal-tab",
    "vault:open",
    "editor:close-tab",
    "editor:reopen-closed-tab",
    "vault:search",
    "layout:toggle-sidebar",
    "layout:toggle-right-panel",
    "nav:command-palette",
    "nav:quick-switcher",
    "app:zoom-in",
    "app:zoom-out",
    "app:zoom-reset",
    "nav:back",
    "nav:forward",
    "nav:next-tab",
    "nav:previous-tab",
]);

let nativeMenuShortcutAccelerators: Record<string, string | null> | null =
    null;
const nativeMenuShortcutCaptureWindows = new Map<
    number,
    { window: BrowserWindow; release: () => void }
>();

function sendRuntimeEvent(
    window: BrowserWindow | null,
    eventName: string,
    payload: unknown,
) {
    if (!window || window.isDestroyed()) return false;
    window.webContents.send(ELECTRON_IPC.event, { eventName, payload });
    return true;
}

function focusWindow(window: BrowserWindow) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
}

function canReceiveMenuAction(window: BrowserWindow | null) {
    if (!window || window.isDestroyed()) return false;

    const label = getWindowLabel(window);
    if (
        label === "settings" ||
        label.startsWith("settings-") ||
        label.startsWith("ghost")
    ) {
        return false;
    }

    const route = getWindowVaultRoute(label);
    if (!route) return true;
    return route.windowKind === "main" || route.windowKind === "note";
}

function getFirstVaultWindow() {
    return BrowserWindow.getAllWindows().find((window) => {
        if (window.isDestroyed()) return false;
        const label = getWindowLabel(window);
        return label.startsWith("vault-") && canReceiveMenuAction(window);
    }) ?? null;
}

export function resolveMenuTargetWindow() {
    const focused = BrowserWindow.getFocusedWindow();
    if (canReceiveMenuAction(focused)) return focused;

    const main = getWindowByLabel("main");
    if (canReceiveMenuAction(main)) return main;

    const vault = getFirstVaultWindow();
    if (vault) return vault;

    return BrowserWindow.getAllWindows().find(canReceiveMenuAction) ?? null;
}

function resolveDockTargetWindow() {
    const routeLabel = selectMainWindowRouteLabel();
    const routed = routeLabel ? getWindowByLabel(routeLabel) : null;
    if (routed && !routed.isDestroyed()) return routed;

    const main = getWindowByLabel("main");
    if (main && !main.isDestroyed()) return main;

    return createAppWindow("main");
}

function emitMenuAction(commandId: string) {
    if (!nativeMenuCommands.has(commandId)) return;

    const target = resolveMenuTargetWindow();
    if (target) focusWindow(target);
    sendRuntimeEvent(target, MENU_ACTION_EVENT, commandId);
}

function emitDockOpenVault(vaultPath: string) {
    const target = resolveDockTargetWindow();
    focusWindow(target);
    sendRuntimeEvent(target, DOCK_OPEN_VAULT_EVENT, vaultPath);
}

function toggleFocusedWindowMaximized() {
    const target =
        BrowserWindow.getFocusedWindow() ??
        getWindowByLabel("main") ??
        BrowserWindow.getAllWindows()[0];
    if (!target || target.isDestroyed()) return;

    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
}

function commandItem(
    id: string,
    label: string,
    accelerator?: string,
): MenuItemConstructorOptions {
    const hasSyncedAccelerator =
        nativeMenuShortcutAccelerators !== null &&
        Object.prototype.hasOwnProperty.call(
            nativeMenuShortcutAccelerators,
            id,
        );
    const effectiveAccelerator =
        accelerator !== undefined &&
        configurableNativeMenuCommands.has(id) &&
        hasSyncedAccelerator
            ? (nativeMenuShortcutAccelerators?.[id] ?? undefined)
            : accelerator;
    return {
        id,
        label,
        accelerator: effectiveAccelerator,
        click: () => emitMenuAction(id),
    };
}

function separator(): MenuItemConstructorOptions {
    return { type: "separator" };
}

function platformShortcut(macos: string, other: string) {
    return process.platform === "darwin" ? macos : other;
}

function suspendMenuAccelerators(items: MenuItemConstructorOptions[]) {
    for (const item of items) {
        item.registerAccelerator = false;
        if (Array.isArray(item.submenu)) {
            suspendMenuAccelerators(item.submenu);
        }
    }
}

function refreshNativeApplicationMenu() {
    if (process.platform === "darwin") {
        Menu.setApplicationMenu(buildApplicationMenu());
    }
}

function buildApplicationMenu() {
    const appMenu: MenuItemConstructorOptions = {
        label: app.name,
        submenu: [
            { role: "about" },
            separator(),
            commandItem("app:open-settings", "Settings...", "CommandOrControl+,"),
            separator(),
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            separator(),
            { role: "quit" },
        ],
    };

    const fileMenu: MenuItemConstructorOptions = {
        label: "File",
        submenu: [
            commandItem("vault:new-note", "New Note", "CommandOrControl+N"),
            commandItem("editor:new-tab", "New Tab", "CommandOrControl+T"),
            commandItem(
                "workspace:new-terminal-tab",
                "New Terminal",
                "CommandOrControl+R",
            ),
            commandItem("vault:open", "Open Vault...", "Shift+CommandOrControl+O"),
            separator(),
            commandItem("editor:close-tab", "Close Tab", "CommandOrControl+W"),
            commandItem(
                "editor:reopen-closed-tab",
                "Reopen Closed Tab",
                "Shift+CommandOrControl+T",
            ),
            separator(),
            commandItem("editor:save-active-note", "Save", "Shift+CommandOrControl+S"),
        ],
    };

    const editMenu: MenuItemConstructorOptions = {
        label: "Edit",
        submenu: [
            { role: "undo" },
            { role: "redo" },
            separator(),
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
            separator(),
            commandItem("editor:search-in-note", "Find in Note...", "CommandOrControl+F"),
            commandItem("vault:search", "Search in Vault...", "Shift+CommandOrControl+F"),
        ],
    };

    const formatMenu: MenuItemConstructorOptions = {
        label: "Format",
        submenu: [
            commandItem("editor:bold-selection", "Bold", "CommandOrControl+B"),
            commandItem("editor:highlight-selection", "Highlight", "Shift+CommandOrControl+H"),
            separator(),
            commandItem("editor:heading-1", "Heading 1", "CommandOrControl+1"),
            commandItem("editor:heading-2", "Heading 2", "CommandOrControl+2"),
            commandItem("editor:heading-3", "Heading 3", "CommandOrControl+3"),
            commandItem("editor:heading-4", "Heading 4", "CommandOrControl+4"),
            commandItem("editor:heading-5", "Heading 5", "CommandOrControl+5"),
            commandItem("editor:heading-6", "Heading 6", "CommandOrControl+6"),
            commandItem("editor:heading-0", "Remove Heading", "Shift+CommandOrControl+0"),
        ],
    };

    const viewMenu: MenuItemConstructorOptions = {
        label: "View",
        submenu: [
            commandItem(
                "editor:toggle-live-preview",
                "Toggle Live Preview",
                "CommandOrControl+E",
            ),
            separator(),
            commandItem("layout:toggle-sidebar", "Toggle Sidebar", "CommandOrControl+S"),
            commandItem("layout:toggle-right-panel", "Toggle Right Panel", "CommandOrControl+J"),
            separator(),
            commandItem("nav:command-palette", "Command Palette...", "CommandOrControl+K"),
            commandItem("nav:quick-switcher", "Quick Switcher...", "CommandOrControl+O"),
            separator(),
            commandItem("app:zoom-in", "Zoom In", "CommandOrControl+="),
            commandItem("app:zoom-out", "Zoom Out", "CommandOrControl+-"),
            commandItem("app:zoom-reset", "Actual Size", "CommandOrControl+0"),
            separator(),
            { role: "togglefullscreen" },
        ],
    };

    const goMenu: MenuItemConstructorOptions = {
        label: "Go",
        submenu: [
            commandItem("nav:back", "Back", "CommandOrControl+["),
            commandItem("nav:forward", "Forward", "CommandOrControl+]"),
            separator(),
            commandItem("nav:next-tab", "Next Tab", "Control+Tab"),
            commandItem(
                "nav:previous-tab",
                "Previous Tab",
                platformShortcut("Alt+CommandOrControl+T", "Control+Shift+Tab"),
            ),
        ],
    };

    const windowMenu: MenuItemConstructorOptions = {
        label: "Window",
        submenu: [
            { role: "minimize" },
            process.platform === "darwin"
                ? { role: "zoom" }
                : { label: "Maximize", click: toggleFocusedWindowMaximized },
            separator(),
            { role: "close" },
        ],
    };

    const helpMenu: MenuItemConstructorOptions = {
        label: "Help",
        submenu: [commandItem("app:open-settings", "Keyboard Shortcuts")],
    };

    const template = [
        appMenu,
        fileMenu,
        editMenu,
        formatMenu,
        viewMenu,
        goMenu,
        windowMenu,
        helpMenu,
    ];
    if (nativeMenuShortcutCaptureWindows.size > 0) {
        suspendMenuAccelerators(template);
    }
    return Menu.buildFromTemplate(template);
}

function buildDockMenu() {
    const recentVaults = getRecentVaultsSnapshot();
    const vaultItems: MenuItemConstructorOptions[] =
        recentVaults.length === 0
            ? [{ label: "No vaults registered", enabled: false }]
            : recentVaults.map((vault) => ({
                  label: vault.name,
                  toolTip: vault.path,
                  click: () => emitDockOpenVault(vault.path),
              }));

    return Menu.buildFromTemplate([
        {
            label: "Vaults",
            submenu: vaultItems,
        },
    ]);
}

export async function refreshDockMenu() {
    if (process.platform !== "darwin" || !app.dock) return;
    await loadRecentVaults();
    app.dock.setMenu(buildDockMenu());
}

export async function syncRecentVaultsForElectron(rawVaults: unknown) {
    await syncRecentVaults(rawVaults);
    await refreshDockMenu();
}

export function syncNativeMenuShortcutAccelerators(rawValue: unknown) {
    const value =
        rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
            ? (rawValue as Record<string, unknown>)
            : {};
    const nextAccelerators: Record<string, string | null> = {};
    for (const commandId of configurableNativeMenuCommands) {
        if (!Object.prototype.hasOwnProperty.call(value, commandId)) {
            continue;
        }
        const accelerator = value[commandId];
        nextAccelerators[commandId] =
            typeof accelerator === "string" && accelerator.length > 0
                ? accelerator
                : null;
    }

    nativeMenuShortcutAccelerators = nextAccelerators;
    refreshNativeApplicationMenu();
    return true;
}

function clearNativeMenuShortcutCapture(windowId: number) {
    const capture = nativeMenuShortcutCaptureWindows.get(windowId);
    if (!capture) return;

    nativeMenuShortcutCaptureWindows.delete(windowId);
    capture.window.removeListener("closed", capture.release);
    capture.window.webContents.removeListener(
        "render-process-gone",
        capture.release,
    );
    capture.window.webContents.removeListener("destroyed", capture.release);
    refreshNativeApplicationMenu();
}

export function setNativeMenuShortcutCaptureActive(
    sourceWindow: BrowserWindow | null,
    rawValue: unknown,
) {
    if (!sourceWindow || sourceWindow.isDestroyed()) {
        return false;
    }

    const windowId = sourceWindow.webContents.id;
    if (rawValue !== true) {
        clearNativeMenuShortcutCapture(windowId);
        return true;
    }

    if (nativeMenuShortcutCaptureWindows.has(windowId)) {
        return true;
    }

    const release = () => clearNativeMenuShortcutCapture(windowId);
    nativeMenuShortcutCaptureWindows.set(windowId, {
        window: sourceWindow,
        release,
    });
    sourceWindow.once("closed", release);
    sourceWindow.webContents.once("render-process-gone", release);
    sourceWindow.webContents.once("destroyed", release);
    refreshNativeApplicationMenu();
    return true;
}

export async function installNativeMenus() {
    if (process.platform !== "darwin") {
        Menu.setApplicationMenu(null);
        return;
    }

    Menu.setApplicationMenu(buildApplicationMenu());
    await refreshDockMenu();
}
