import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu } from "electron";

const electronMocks = vi.hoisted(() => ({
    buildFromTemplate: vi.fn((template) => ({ template })),
    setApplicationMenu: vi.fn(),
}));

vi.mock("electron", () => ({
    app: { name: "NeverWrite" },
    BrowserWindow: {
        getAllWindows: vi.fn(() => []),
        getFocusedWindow: vi.fn(() => null),
    },
    Menu: {
        buildFromTemplate: electronMocks.buildFromTemplate,
        setApplicationMenu: electronMocks.setApplicationMenu,
    },
}));

vi.mock("./window", () => ({
    createAppWindow: vi.fn(),
    getWindowByLabel: vi.fn(() => null),
    getWindowLabel: vi.fn(() => "settings"),
}));

vi.mock("./shellState", () => ({
    getRecentVaultsSnapshot: vi.fn(() => []),
    getWindowVaultRoute: vi.fn(() => null),
    loadRecentVaults: vi.fn(),
    selectMainWindowRouteLabel: vi.fn(() => null),
    syncRecentVaults: vi.fn(),
}));

import { setNativeMenuShortcutCaptureActive } from "./menu";

type Listener = () => void;

function createWindow(id: number) {
    const windowListeners = new Map<string, Listener>();
    const webContentsListeners = new Map<string, Listener>();
    let destroyed = false;
    const window = {
        isDestroyed: () => destroyed,
        once: (eventName: string, listener: Listener) => {
            windowListeners.set(eventName, listener);
        },
        removeListener: (eventName: string, listener: Listener) => {
            if (windowListeners.get(eventName) === listener) {
                windowListeners.delete(eventName);
            }
        },
        webContents: {
            id,
            once: (eventName: string, listener: Listener) => {
                webContentsListeners.set(eventName, listener);
            },
            removeListener: (eventName: string, listener: Listener) => {
                if (webContentsListeners.get(eventName) === listener) {
                    webContentsListeners.delete(eventName);
                }
            },
        },
    };

    return {
        window: window as never,
        close() {
            destroyed = true;
            windowListeners.get("closed")?.();
        },
        crashRenderer() {
            webContentsListeners.get("render-process-gone")?.();
        },
    };
}

function latestNewNoteMenuItem() {
    const applicationMenu = vi.mocked(Menu.setApplicationMenu).mock.calls.at(
        -1,
    )?.[0] as unknown as {
        template: Array<{ submenu?: Array<{ id?: string; registerAccelerator?: boolean }> }>;
    };
    const fileMenu = applicationMenu.template.find((item) =>
        item.submenu?.some((submenuItem) => submenuItem.id === "vault:new-note"),
    );
    return fileMenu?.submenu?.find((item) => item.id === "vault:new-note");
}

const originalPlatform = process.platform;

beforeEach(() => {
    Object.defineProperty(process, "platform", {
        configurable: true,
        value: "darwin",
    });
    electronMocks.buildFromTemplate.mockClear();
    electronMocks.setApplicationMenu.mockClear();
});

afterEach(() => {
    Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
    });
});

describe("native menu shortcut capture", () => {
    it("restores menu accelerators when the recording window closes", () => {
        const settingsWindow = createWindow(1);

        expect(
            setNativeMenuShortcutCaptureActive(settingsWindow.window, true),
        ).toBe(true);
        expect(latestNewNoteMenuItem()?.registerAccelerator).toBe(false);

        settingsWindow.close();

        expect(latestNewNoteMenuItem()?.registerAccelerator).toBeUndefined();
    });

    it("keeps accelerators suspended until every recording window is released", () => {
        const firstSettingsWindow = createWindow(1);
        const secondSettingsWindow = createWindow(2);

        setNativeMenuShortcutCaptureActive(firstSettingsWindow.window, true);
        setNativeMenuShortcutCaptureActive(secondSettingsWindow.window, true);
        firstSettingsWindow.close();

        expect(latestNewNoteMenuItem()?.registerAccelerator).toBe(false);

        expect(
            setNativeMenuShortcutCaptureActive(secondSettingsWindow.window, false),
        ).toBe(true);
        expect(latestNewNoteMenuItem()?.registerAccelerator).toBeUndefined();
    });

    it("restores accelerators when the recording renderer crashes", () => {
        const settingsWindow = createWindow(1);

        setNativeMenuShortcutCaptureActive(settingsWindow.window, true);
        settingsWindow.crashRenderer();

        expect(latestNewNoteMenuItem()?.registerAccelerator).toBeUndefined();
    });
});
