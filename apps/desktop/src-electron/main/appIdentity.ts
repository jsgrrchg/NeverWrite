import path from "node:path";
import type { App } from "electron";

export const RELEASE_APP_ID = "com.neverwrite";
export const DEVELOPMENT_APP_ID = "com.neverwrite.dev";
export const RELEASE_APP_NAME = "NeverWrite";
export const DEVELOPMENT_APP_NAME = "NeverWrite Dev";
export const RELEASE_SECRET_SERVICE = "NeverWrite AI Provider Secrets";
export const DEVELOPMENT_SECRET_SERVICE =
    "NeverWrite Dev AI Provider Secrets";

export interface AppIdentity {
    variant: "release" | "development";
    displayName: typeof RELEASE_APP_NAME | typeof DEVELOPMENT_APP_NAME;
    appUserModelId: string;
    userDataDirectoryName:
        | typeof RELEASE_APP_NAME
        | typeof DEVELOPMENT_APP_NAME;
    ownsProductionDeepLinks: boolean;
    enablesWebClipperServer: boolean;
    secretServiceName:
        | typeof RELEASE_SECRET_SERVICE
        | typeof DEVELOPMENT_SECRET_SERVICE;
}

export function resolveAppIdentity({
    isPackaged,
    releaseAppUserModelId,
}: {
    isPackaged: boolean;
    releaseAppUserModelId?: string;
}): AppIdentity {
    if (!isPackaged) {
        return {
            variant: "development",
            displayName: DEVELOPMENT_APP_NAME,
            appUserModelId: DEVELOPMENT_APP_ID,
            userDataDirectoryName: DEVELOPMENT_APP_NAME,
            ownsProductionDeepLinks: false,
            enablesWebClipperServer: false,
            secretServiceName: DEVELOPMENT_SECRET_SERVICE,
        };
    }

    return {
        variant: "release",
        displayName: RELEASE_APP_NAME,
        appUserModelId:
            releaseAppUserModelId?.trim() || RELEASE_APP_ID,
        userDataDirectoryName: RELEASE_APP_NAME,
        ownsProductionDeepLinks: true,
        enablesWebClipperServer: true,
        secretServiceName: RELEASE_SECRET_SERVICE,
    };
}

export function applyAppIdentity(
    electronApp: Pick<
        App,
        | "getPath"
        | "getVersion"
        | "setAboutPanelOptions"
        | "setAppUserModelId"
        | "setName"
        | "setPath"
    >,
    identity: AppIdentity,
    platform: NodeJS.Platform = process.platform,
) {
    electronApp.setName(identity.displayName);

    // Release deliberately keeps Electron's existing userData resolution so
    // installed users continue on the canonical NeverWrite profile unchanged.
    if (identity.variant === "development") {
        electronApp.setPath(
            "userData",
            path.join(
                electronApp.getPath("appData"),
                identity.userDataDirectoryName,
            ),
        );
    }

    if (platform === "win32") {
        electronApp.setAppUserModelId(identity.appUserModelId);
    }
    if (platform === "darwin") {
        electronApp.setAboutPanelOptions({
            applicationName: identity.displayName,
            applicationVersion: electronApp.getVersion(),
        });
    }
}

export function registerProductionProtocolClient(
    electronApp: Pick<App, "setAsDefaultProtocolClient">,
    identity: AppIdentity,
) {
    if (!identity.ownsProductionDeepLinks) return false;
    return electronApp.setAsDefaultProtocolClient("neverwrite");
}
