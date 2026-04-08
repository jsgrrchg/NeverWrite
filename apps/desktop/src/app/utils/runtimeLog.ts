import {
    DEBUG_SCOPE_STORAGE_KEY,
    RUNTIME_LOG_WINDOW_API,
} from "./technicalBranding";

const DEBUG_SCOPE_ALL = "*";
const logOnceKeys = new Set<string>();

export type RuntimeLogOptions = {
    onceKey?: string;
};

type RuntimeLogApi = {
    enable: (...scopes: string[]) => string[];
    disable: (...scopes: string[]) => string[];
    clear: () => string[];
    scopes: () => string[];
    enabled: (scope: string) => boolean;
};

function normalizeScope(scope: string) {
    return scope.trim().toLowerCase();
}

function readStoredDebugScopes(): Set<string> {
    if (typeof window === "undefined") {
        return new Set();
    }

    try {
        const raw = window.localStorage.getItem(DEBUG_SCOPE_STORAGE_KEY);
        if (!raw) {
            return new Set();
        }

        const parsed = raw.trim().startsWith("[")
            ? (JSON.parse(raw) as unknown)
            : raw.split(/[,\s]+/);
        const values = Array.isArray(parsed) ? parsed : [parsed];

        return new Set(
            values
                .filter((value): value is string => typeof value === "string")
                .map(normalizeScope)
                .filter(Boolean),
        );
    } catch {
        return new Set();
    }
}

function writeStoredDebugScopes(scopes: Set<string>) {
    if (typeof window === "undefined") {
        return;
    }

    try {
        if (scopes.size === 0) {
            window.localStorage.removeItem(DEBUG_SCOPE_STORAGE_KEY);
            return;
        }

        window.localStorage.setItem(
            DEBUG_SCOPE_STORAGE_KEY,
            JSON.stringify([...scopes].sort()),
        );
    } catch {
        // Best-effort debug configuration.
    }
}

function shouldLogOnce(level: "warn" | "error" | "debug", key: string) {
    const scopedKey = `${level}:${key}`;
    if (logOnceKeys.has(scopedKey)) {
        return false;
    }
    logOnceKeys.add(scopedKey);
    return true;
}

function formatScopedMessage(scope: string, message: string) {
    return `[${scope}] ${message}`;
}

export function isDebugLogEnabled(scope: string) {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) {
        return false;
    }

    const scopes = readStoredDebugScopes();
    return scopes.has(DEBUG_SCOPE_ALL) || scopes.has(normalizedScope);
}

export function logDebug(
    scope: string,
    message: string,
    detail?: unknown,
    options?: RuntimeLogOptions,
) {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope || !isDebugLogEnabled(normalizedScope)) {
        return;
    }
    const onceKey = options?.onceKey ?? `${normalizedScope}:${message}`;
    if (!shouldLogOnce("debug", onceKey)) {
        return;
    }

    const scopedMessage = formatScopedMessage(normalizedScope, message);
    if (detail === undefined) {
        console.debug(scopedMessage);
        return;
    }
    console.debug(scopedMessage, detail);
}

export function logWarn(
    scope: string,
    message: string,
    detail?: unknown,
    options?: RuntimeLogOptions,
) {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) {
        return;
    }
    if (options?.onceKey && !shouldLogOnce("warn", options.onceKey)) {
        return;
    }

    const scopedMessage = formatScopedMessage(normalizedScope, message);
    if (detail === undefined) {
        console.warn(scopedMessage);
        return;
    }
    console.warn(scopedMessage, detail);
}

export function logError(
    scope: string,
    message: string,
    detail?: unknown,
    options?: RuntimeLogOptions,
) {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) {
        return;
    }
    if (options?.onceKey && !shouldLogOnce("error", options.onceKey)) {
        return;
    }

    const scopedMessage = formatScopedMessage(normalizedScope, message);
    if (detail === undefined) {
        console.error(scopedMessage);
        return;
    }
    console.error(scopedMessage, detail);
}

function createRuntimeLogApi(): RuntimeLogApi {
    return {
        enable: (...scopes: string[]) => {
            const next = readStoredDebugScopes();
            for (const scope of scopes) {
                const normalized = normalizeScope(scope);
                if (normalized) {
                    next.add(normalized);
                }
            }
            writeStoredDebugScopes(next);
            return [...next].sort();
        },
        disable: (...scopes: string[]) => {
            const next = readStoredDebugScopes();
            for (const scope of scopes) {
                next.delete(normalizeScope(scope));
            }
            writeStoredDebugScopes(next);
            return [...next].sort();
        },
        clear: () => {
            const next = new Set<string>();
            writeStoredDebugScopes(next);
            return [];
        },
        scopes: () => [...readStoredDebugScopes()].sort(),
        enabled: (scope: string) => isDebugLogEnabled(scope),
    };
}

function installRuntimeLogApi() {
    if (typeof window === "undefined") {
        return;
    }

    const existing = window[RUNTIME_LOG_WINDOW_API];

    if (!existing) {
        const api = createRuntimeLogApi();
        window[RUNTIME_LOG_WINDOW_API] = api;
    }
}

installRuntimeLogApi();

export function resetRuntimeLogStateForTests() {
    logOnceKeys.clear();
    if (typeof window !== "undefined") {
        try {
            window.localStorage.removeItem(DEBUG_SCOPE_STORAGE_KEY);
        } catch {
            // ignore test cleanup failures
        }
        const api = createRuntimeLogApi();
        window[RUNTIME_LOG_WINDOW_API] = api;
    }
}

declare global {
    interface Window {
        __neverwriteLogs?: RuntimeLogApi;
    }
}
