import { app, BrowserWindow, protocol } from "electron";
import { createAppWindow } from "./window";
import {
    registerIpcHandlers,
    registerPreviewProtocolHandler,
} from "./ipc";

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
    if (process.platform === "darwin") {
        app.setAboutPanelOptions({
            applicationName: "NeverWrite",
            applicationVersion: "0.1.0",
        });
    }
}

configureAppIdentity();

const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        const existing =
            BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (existing) {
            if (existing.isMinimized()) existing.restore();
            existing.show();
            existing.focus();
            return;
        }
        createAppWindow("main");
    });

    void app.whenReady().then(() => {
        protocol.handle("neverwrite-file", registerPreviewProtocolHandler());
        registerIpcHandlers();
        createAppWindow("main");

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createAppWindow("main");
            }
        });
    });
}

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
