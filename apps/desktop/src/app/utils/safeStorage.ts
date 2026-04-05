import { logWarn } from "./runtimeLog";

const SAFE_STORAGE_EVENT = "vaultai:safe-storage";
const STORAGE_PROBE_KEY = "__vaultai_storage_probe__";

type SafeStorageDetail = {
    key: string;
    newValue: string | null;
};

type StorageBackend = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
    clear: () => void;
    key: (index: number) => string | null;
    readonly length: number;
    readonly kind: "local" | "memory";
};

function createMemoryBackend(): StorageBackend {
    const map = new Map<string, string>();

    return {
        kind: "memory",
        getItem(key) {
            return map.get(key) ?? null;
        },
        setItem(key, value) {
            map.set(key, value);
        },
        removeItem(key) {
            map.delete(key);
        },
        clear() {
            map.clear();
        },
        key(index) {
            return [...map.keys()][index] ?? null;
        },
        get length() {
            return map.size;
        },
    };
}

function canUseLocalStorage(storage: Storage): boolean {
    try {
        storage.getItem(STORAGE_PROBE_KEY);
        storage.setItem(STORAGE_PROBE_KEY, "1");
        storage.removeItem(STORAGE_PROBE_KEY);
        return true;
    } catch {
        return false;
    }
}

let backend: StorageBackend | null = null;

// Prefer persistent localStorage when it is readable and writable.
// If the environment blocks it, fall back to an in-memory backend so callers
// can keep using the same API without throwing.
function resolveBackend(): StorageBackend {
    if (backend) {
        return backend;
    }

    if (typeof window !== "undefined") {
        try {
            if (canUseLocalStorage(window.localStorage)) {
                backend = {
                    kind: "local",
                    getItem: (key) => window.localStorage.getItem(key),
                    setItem: (key, value) =>
                        window.localStorage.setItem(key, value),
                    removeItem: (key) => window.localStorage.removeItem(key),
                    clear: () => window.localStorage.clear(),
                    key: (index) => window.localStorage.key(index),
                    get length() {
                        return window.localStorage.length;
                    },
                };
                return backend;
            }
        } catch {
            // Fall back to memory storage below.
        }
    }

    backend = createMemoryBackend();
    return backend;
}

function dispatchSafeStorageEvent(key: string, newValue: string | null) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
        new CustomEvent<SafeStorageDetail>(SAFE_STORAGE_EVENT, {
            detail: { key, newValue },
        }),
    );
}

export function safeStorageKind() {
    return resolveBackend().kind;
}

export function safeStorageIsPersistent() {
    return safeStorageKind() === "local";
}

export function safeStorageGetItem(key: string): string | null {
    try {
        return resolveBackend().getItem(key);
    } catch {
        return null;
    }
}

export function safeStorageTrySetItem(key: string, value: string) {
    try {
        resolveBackend().setItem(key, value);
        dispatchSafeStorageEvent(key, value);
        return true;
    } catch {
        return false;
    }
}

export function safeStorageSetItem(key: string, value: string) {
    if (safeStorageTrySetItem(key, value)) {
        return true;
    }
    // This API is intentionally best-effort: callers get a boolean result and a
    // deduplicated warning instead of a thrown write failure.
    logWarn(
        "safe-storage",
        "Failed to persist safe storage item",
        { key },
        {
            onceKey: `set:${key}`,
        },
    );
    return false;
}

export function safeStorageRemoveItem(key: string) {
    try {
        resolveBackend().removeItem(key);
        dispatchSafeStorageEvent(key, null);
        return true;
    } catch (error) {
        logWarn(
            "safe-storage",
            "Failed to remove safe storage item",
            { key, error },
            { onceKey: `remove:${key}` },
        );
        return false;
    }
}

export function safeStorageClear() {
    try {
        const keys = safeStorageKeys();
        resolveBackend().clear();
        for (const key of keys) {
            dispatchSafeStorageEvent(key, null);
        }
        return true;
    } catch (error) {
        logWarn("safe-storage", "Failed to clear safe storage", error, {
            onceKey: "clear",
        });
        return false;
    }
}

export function safeStorageKey(index: number) {
    try {
        return resolveBackend().key(index);
    } catch {
        return null;
    }
}

export function safeStorageLength() {
    try {
        return resolveBackend().length;
    } catch {
        return 0;
    }
}

export function safeStorageKeys() {
    const keys: string[] = [];
    const length = safeStorageLength();
    for (let index = 0; index < length; index += 1) {
        const key = safeStorageKey(index);
        if (key) {
            keys.push(key);
        }
    }
    return keys;
}

export function subscribeSafeStorage(
    listener: (event: { key: string | null; newValue: string | null }) => void,
) {
    if (typeof window === "undefined") {
        return () => {};
    }

    const onStorage = (event: StorageEvent) => {
        listener({ key: event.key, newValue: event.newValue });
    };
    const onSafeStorage = (event: Event) => {
        const detail = (event as CustomEvent<SafeStorageDetail>).detail;
        listener({ key: detail.key, newValue: detail.newValue });
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(SAFE_STORAGE_EVENT, onSafeStorage);

    return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(SAFE_STORAGE_EVENT, onSafeStorage);
    };
}
