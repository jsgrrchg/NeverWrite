import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";

export interface AvailableAppUpdate extends Pick<
    Update,
    "body" | "currentVersion" | "version" | "date" | "rawJson"
> {
    target: string;
    downloadUrl: string;
}

export interface AppUpdateStatus {
    enabled: boolean;
    currentVersion: string;
    channel: string;
    endpoint: string | null;
    message: string | null;
    update: AvailableAppUpdate | null;
}

export async function getAppUpdateConfiguration() {
    return invoke<AppUpdateStatus>("get_app_update_configuration");
}

export async function checkForAppUpdate() {
    return invoke<AppUpdateStatus>("check_for_app_update");
}

export async function downloadAndInstallAppUpdate(args: {
    version: string;
    target: string;
}) {
    return invoke<void>("download_and_install_app_update", args);
}
