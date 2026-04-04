import { create } from "zustand";
import {
    checkForAppUpdate,
    downloadAndInstallAppUpdate,
    getAppUpdateConfiguration,
    type AppUpdateStatus,
} from "./api";

type InitializeOptions = {
    backgroundCheck?: boolean;
};

interface AppUpdateStore {
    status: AppUpdateStatus | null;
    loading: boolean;
    initialized: boolean;
    checking: boolean;
    installing: boolean;
    error: string | null;
    hasChecked: boolean;
    lastCheckedAt: number | null;
    initialize: (options?: InitializeOptions) => Promise<AppUpdateStatus | null>;
    checkNow: (options?: { background?: boolean }) => Promise<AppUpdateStatus | null>;
    installAvailableUpdate: () => Promise<void>;
    reset: () => void;
}

let initializePromise: Promise<AppUpdateStatus | null> | null = null;
let checkPromise: Promise<AppUpdateStatus | null> | null = null;
let installPromise: Promise<void> | null = null;

function toErrorMessage(reason: unknown, fallback: string) {
    return reason instanceof Error ? reason.message : fallback;
}

export const useAppUpdateStore = create<AppUpdateStore>((set, get) => ({
    status: null,
    loading: false,
    initialized: false,
    checking: false,
    installing: false,
    error: null,
    hasChecked: false,
    lastCheckedAt: null,

    initialize: async (options) => {
        if (initializePromise) {
            return initializePromise;
        }

        if (get().initialized) {
            if (options?.backgroundCheck && !get().hasChecked) {
                void get().checkNow({ background: true });
            }
            return get().status;
        }

        set({ loading: true, error: null });
        initializePromise = getAppUpdateConfiguration()
            .then((status) => {
                set({
                    status,
                    loading: false,
                    initialized: true,
                    error: null,
                });
                if (options?.backgroundCheck && status.enabled) {
                    void get().checkNow({ background: true });
                }
                return status;
            })
            .catch((reason) => {
                const message = toErrorMessage(
                    reason,
                    "Failed to load updater configuration.",
                );
                set({
                    loading: false,
                    initialized: true,
                    error: message,
                });
                return get().status;
            })
            .finally(() => {
                initializePromise = null;
            });

        return initializePromise;
    },

    checkNow: async (options) => {
        if (checkPromise) {
            return checkPromise;
        }

        if (!get().initialized) {
            await get().initialize();
        }

        set({
            checking: true,
            error: options?.background ? get().error : null,
        });

        checkPromise = checkForAppUpdate()
            .then((status) => {
                set({
                    status,
                    checking: false,
                    error: null,
                    hasChecked: true,
                    lastCheckedAt: Date.now(),
                });
                return status;
            })
            .catch((reason) => {
                const message = toErrorMessage(
                    reason,
                    "Failed to check for updates.",
                );
                set({
                    checking: false,
                    error: message,
                    hasChecked: true,
                    lastCheckedAt: Date.now(),
                });
                return get().status;
            })
            .finally(() => {
                checkPromise = null;
            });

        return checkPromise;
    },

    installAvailableUpdate: async () => {
        if (installPromise) {
            return installPromise;
        }

        const update = get().status?.update;
        if (!update) {
            throw new Error("No app update is currently available.");
        }

        set({ installing: true, error: null });
        installPromise = downloadAndInstallAppUpdate({
            version: update.version,
            target: update.target,
        })
            .catch((reason) => {
                const message = toErrorMessage(
                    reason,
                    "Failed to download and install the update.",
                );
                set({ installing: false, error: message });
                throw reason;
            })
            .finally(() => {
                installPromise = null;
            });

        return installPromise;
    },

    reset: () => {
        initializePromise = null;
        checkPromise = null;
        installPromise = null;
        set({
            status: null,
            loading: false,
            initialized: false,
            checking: false,
            installing: false,
            error: null,
            hasChecked: false,
            lastCheckedAt: null,
        });
    },
}));
