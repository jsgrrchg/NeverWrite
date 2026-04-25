import { app, BrowserWindow, protocol } from "electron";
import { installNativeMenus, refreshDockMenu } from "./menu";
import { createAppWindow, getWindowByLabel } from "./window";
import {
    extractWebClipperDeepLinksFromArgv,
    handleWebClipperDeepLink,
} from "./webClipper";
import {
    registerIpcHandlers,
    registerPreviewProtocolHandler,
} from "./ipc";

const WINDOWS_APP_USER_MODEL_ID =
    process.env.NEVERWRITE_ELECTRON_APP_ID?.trim() || "com.neverwrite";

protocol.registerSchemesAsPrivileged([
    {
        scheme: "neverwrite-file",
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
        },
    },
]);

function configureAppIdentity() {
    app.setName("NeverWrite");
    if (process.platform === "win32") {
        app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
    }
    if (process.platform === "darwin") {
        app.setAboutPanelOptions({
            applicationName: "NeverWrite",
            applicationVersion: app.getVersion(),
        });
    }
}

configureAppIdentity();
app.setAsDefaultProtocolClient("neverwrite");

app.on("open-url", (event, url) => {
    event.preventDefault();
    focusOrCreateMainWindow();
    handleWebClipperDeepLink(url);
});

function focusOrCreateMainWindow() {
    const existing =
        BrowserWindow.getFocusedWindow() ??
        getWindowByLabel("main") ??
        BrowserWindow.getAllWindows()[0];

    if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
        return existing;
    }

    return createAppWindow("main");
}

const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
    app.quit();
} else {
    app.on("second-instance", (_event, argv) => {
        focusOrCreateMainWindow();
        for (const url of extractWebClipperDeepLinksFromArgv(argv)) {
            handleWebClipperDeepLink(url);
        }
    });

    void app.whenReady().then(() => {
        protocol.handle("neverwrite-file", registerPreviewProtocolHandler());
        registerIpcHandlers();
        void installNativeMenus();
        createAppWindow("main");
        for (const url of extractWebClipperDeepLinksFromArgv(process.argv)) {
            handleWebClipperDeepLink(url);
        }

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createAppWindow("main");
            }
            void refreshDockMenu();
        });
    });
}

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
