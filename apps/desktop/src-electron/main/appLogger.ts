import fs from "node:fs";
import path from "node:path";
import util from "node:util";

export type AppLogLevel = "debug" | "info" | "warn" | "error";
export type AppLogSource = "main" | "renderer" | "native-backend";

export interface RendererLogEnvelope {
    level: AppLogLevel;
    scope: string;
    message: string;
    detail?: unknown;
    windowLabel?: string | null;
}

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 4;
const REDACTED_VALUE = "[redacted]";
const SENSITIVE_KEY_PATTERN =
    /(?:content|transcript|prompt|message|body|raw|password|token|secret|apiKey|authorization)/i;

let configuredLogDir: string | null = null;
let maxLogBytes = DEFAULT_MAX_LOG_BYTES;
let consoleCaptureInstalled = false;
let processDiagnosticsInstalled = false;

const originalConsole = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

function truncateString(value: string) {
    if (value.length <= MAX_STRING_LENGTH) return value;
    return `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function serializeError(error: Error) {
    return {
        name: error.name,
        message: truncateString(error.message),
        stack: error.stack ? truncateString(error.stack) : undefined,
    };
}

export function sanitizeLogDetail(value: unknown, depth = 0): unknown {
    if (value instanceof Error) {
        return serializeError(value);
    }
    if (typeof value === "string") {
        return truncateString(value);
    }
    if (
        value === null ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "undefined"
    ) {
        return value;
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value === "symbol" || typeof value === "function") {
        return String(value);
    }
    if (depth >= MAX_DEPTH) {
        return "[max-depth]";
    }
    if (Array.isArray(value)) {
        const items = value
            .slice(0, MAX_ARRAY_ITEMS)
            .map((item) => sanitizeLogDetail(item, depth + 1));
        if (value.length > MAX_ARRAY_ITEMS) {
            items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
        }
        return items;
    }
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        const entries = Object.entries(record).slice(0, MAX_OBJECT_KEYS);
        for (const [key, item] of entries) {
            result[key] = SENSITIVE_KEY_PATTERN.test(key)
                ? REDACTED_VALUE
                : sanitizeLogDetail(item, depth + 1);
        }
        const omitted = Object.keys(record).length - entries.length;
        if (omitted > 0) {
            result.__truncatedKeys = omitted;
        }
        return result;
    }
    return String(value);
}

export function resolveAppLogDirectory(userDataDir: string) {
    return path.join(userDataDir, "logs");
}

export function initializeAppLogger(
    userDataDir: string,
    options: { maxBytes?: number } = {},
) {
    configuredLogDir = resolveAppLogDirectory(userDataDir);
    maxLogBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
    fs.mkdirSync(configuredLogDir, { recursive: true });
    return configuredLogDir;
}

export function getConfiguredLogDirectory() {
    return configuredLogDir;
}

function logFileNameForSource(source: AppLogSource) {
    switch (source) {
        case "native-backend":
            return "native-backend.log";
        case "renderer":
            return "renderer.log";
        case "main":
            return "main.log";
    }
}

function rotateLogIfNeeded(filePath: string) {
    try {
        const size = fs.statSync(filePath).size;
        if (size < maxLogBytes) return;
        const rotatedPath = filePath.replace(/\.log$/u, ".old.log");
        fs.rmSync(rotatedPath, { force: true });
        fs.renameSync(filePath, rotatedPath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
            originalConsole.warn("[app-logger] failed to rotate log", error);
        }
    }
}

function formatLogLine(
    source: AppLogSource,
    level: AppLogLevel,
    message: string,
    detail?: unknown,
) {
    const entry = {
        timestamp: new Date().toISOString(),
        source,
        level,
        message: truncateString(message),
        ...(detail === undefined ? {} : { detail: sanitizeLogDetail(detail) }),
    };
    return `${JSON.stringify(entry)}\n`;
}

export function writeAppLog(
    source: AppLogSource,
    level: AppLogLevel,
    message: string,
    detail?: unknown,
) {
    if (!configuredLogDir) return;
    try {
        fs.mkdirSync(configuredLogDir, { recursive: true });
        const filePath = path.join(configuredLogDir, logFileNameForSource(source));
        rotateLogIfNeeded(filePath);
        fs.appendFileSync(filePath, formatLogLine(source, level, message, detail));
    } catch (error) {
        originalConsole.warn("[app-logger] failed to write log", error);
    }
}

function normalizeConsoleArgs(args: unknown[]) {
    const [first, ...rest] = args;
    if (typeof first === "string") {
        return {
            message: first,
            detail: rest.length === 0 ? undefined : rest,
        };
    }
    return {
        message: util.format(...args),
        detail: args.length === 0 ? undefined : args,
    };
}

export function installConsoleLogCapture() {
    if (consoleCaptureInstalled) return;
    consoleCaptureInstalled = true;

    console.debug = (...args: unknown[]) => {
        originalConsole.debug(...args);
        const { message, detail } = normalizeConsoleArgs(args);
        writeAppLog("main", "debug", message, detail);
    };
    console.info = (...args: unknown[]) => {
        originalConsole.info(...args);
        const { message, detail } = normalizeConsoleArgs(args);
        writeAppLog("main", "info", message, detail);
    };
    console.log = (...args: unknown[]) => {
        originalConsole.log(...args);
        const { message, detail } = normalizeConsoleArgs(args);
        writeAppLog("main", "info", message, detail);
    };
    console.warn = (...args: unknown[]) => {
        originalConsole.warn(...args);
        const { message, detail } = normalizeConsoleArgs(args);
        writeAppLog("main", "warn", message, detail);
    };
    console.error = (...args: unknown[]) => {
        originalConsole.error(...args);
        const { message, detail } = normalizeConsoleArgs(args);
        writeAppLog("main", "error", message, detail);
    };
}

export function installProcessDiagnostics() {
    if (processDiagnosticsInstalled) return;
    processDiagnosticsInstalled = true;

    process.on("uncaughtException", (error) => {
        writeAppLog("main", "error", "Uncaught exception", error);
    });
    process.on("unhandledRejection", (reason) => {
        writeAppLog("main", "error", "Unhandled promise rejection", reason);
    });
}

export function writeRendererLog(envelope: RendererLogEnvelope) {
    const scope = envelope.scope.trim() || "renderer";
    const message = `[${scope}] ${envelope.message}`;
    writeAppLog("renderer", envelope.level, message, {
        windowLabel: envelope.windowLabel ?? null,
        detail: envelope.detail,
    });
}

export function resetAppLoggerForTests() {
    configuredLogDir = null;
    maxLogBytes = DEFAULT_MAX_LOG_BYTES;
}
