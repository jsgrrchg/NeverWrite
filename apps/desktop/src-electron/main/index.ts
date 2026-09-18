import { app, BrowserWindow, protocol, session } from "electron";
import { installNativeMenus, refreshDockMenu } from "./menu";
import { createAppWindow, getWindowByLabel } from "./window";
import { extractDeepLinksFromArgv, handleDeepLink } from "./deepLink";
import {
    registerIpcHandlers,
    registerPreviewProtocolHandler,
} from "./ipc";
import {
    initializeAppLogger,
    installConsoleLogCapture,
    installProcessDiagnostics,
    writeAppLog,
} from "./appLogger";
import {
    applyAppIdentity,
    registerProductionProtocolClient,
    resolveAppIdentity,
} from "./appIdentity";
import { installYouTubeEmbedIdentityHeaders } from "./youtubeEmbedIdentity";

const appIdentity = resolveAppIdentity({
    isPackaged: app.isPackaged,
    releaseAppUserModelId: process.env.NEVERWRITE_ELECTRON_APP_ID,
});

applyAppIdentity(app, appIdentity);

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

initializeAppLogger(app.getPath("userData"));
installConsoleLogCapture();
installProcessDiagnostics();
writeAppLog("main", "info", "NeverWrite main process starting", {
    variant: appIdentity.variant,
    applicationName: appIdentity.displayName,
    userDataDirectoryName: appIdentity.userDataDirectoryName,
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
});
registerProductionProtocolClient(app, appIdentity);

app.on("child-process-gone", (_event, details) => {
    writeAppLog("main", "error", "Electron child process gone", details);
});

if (appIdentity.ownsProductionDeepLinks) {
    app.on("open-url", (event, url) => {
        event.preventDefault();
        focusOrCreateMainWindow();
        handleDeepLink(url);
    });
}

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
        if (appIdentity.ownsProductionDeepLinks) {
            for (const url of extractDeepLinksFromArgv(argv)) {
                handleDeepLink(url);
            }
        }
    });

    void app.whenReady().then(() => {
        writeAppLog("main", "info", "Electron app ready");
        installYouTubeEmbedIdentityHeaders(session.defaultSession);
        const backend = registerIpcHandlers({
            enableProductionDeepLinks:
                appIdentity.ownsProductionDeepLinks,
            enableWebClipperServer: appIdentity.enablesWebClipperServer,
            runtimeSecretServiceName: appIdentity.secretServiceName,
        });
        protocol.handle(
            "neverwrite-file",
            registerPreviewProtocolHandler(backend),
        );
        void installNativeMenus();
        createAppWindow("main");
        if (appIdentity.ownsProductionDeepLinks) {
            for (const url of extractDeepLinksFromArgv(process.argv)) {
                handleDeepLink(url);
            }
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
