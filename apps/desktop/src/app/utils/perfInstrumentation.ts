type PerfMetaValue = string | number | boolean | null | undefined;
type PerfMeta = Record<string, PerfMetaValue>;

type PerfMetric = {
    count: number;
    totalMs: number;
    maxMs: number;
    lastMs: number;
    numericTotals: Record<string, number>;
    lastMeta: Record<string, string>;
    updatedAt: number;
};

type PerfEvent = {
    name: string;
    durationMs: number | null;
    meta: Record<string, string | number | boolean | null>;
    at: number;
    scenario: string | null;
};

type PerfSnapshotMetric = PerfMetric & {
    name: string;
    avgMs: number;
};

type PerfSnapshot = {
    enabled: boolean;
    activeScenario: string | null;
    metrics: PerfSnapshotMetric[];
    recentEvents: PerfEvent[];
};

type PerfApi = {
    enable: () => void;
    disable: () => void;
    reset: () => void;
    startScenario: (name: string) => void;
    stopScenario: () => void;
    snapshot: () => PerfSnapshot;
    summary: () => PerfSnapshot;
};

const STORAGE_KEY = "vaultai:perf-probe";
const MAX_EVENTS = 250;

const metrics = new Map<string, PerfMetric>();
const recentEvents: PerfEvent[] = [];

let initialized = false;
let enabled = false;
let activeScenario: string | null = null;

function stringifyMetaValue(value: PerfMetaValue): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    return String(value);
}

function ensureInitialized() {
    if (initialized || typeof window === "undefined") return;
    initialized = true;
    enabled = window.localStorage.getItem(STORAGE_KEY) === "true";

    const api: PerfApi = {
        enable() {
            enabled = true;
            window.localStorage.setItem(STORAGE_KEY, "true");
        },
        disable() {
            enabled = false;
            window.localStorage.removeItem(STORAGE_KEY);
        },
        reset() {
            metrics.clear();
            recentEvents.length = 0;
        },
        startScenario(name: string) {
            activeScenario = name.trim() || null;
        },
        stopScenario() {
            activeScenario = null;
        },
        snapshot() {
            return buildSnapshot();
        },
        summary() {
            const snapshot = buildSnapshot();
            console.table(
                snapshot.metrics.map((metric) => ({
                    metric: metric.name,
                    count: metric.count,
                    avgMs: Number(metric.avgMs.toFixed(3)),
                    maxMs: Number(metric.maxMs.toFixed(3)),
                    lastMs: Number(metric.lastMs.toFixed(3)),
                    ...metric.numericTotals,
                    ...metric.lastMeta,
                })),
            );
            return snapshot;
        },
    };

    window.__vaultAiPerf = api;
}

function buildSnapshot(): PerfSnapshot {
    const metricList = [...metrics.entries()]
        .map(([name, metric]) => ({
            name,
            ...metric,
            avgMs: metric.count > 0 ? metric.totalMs / metric.count : 0,
        }))
        .sort((left, right) => right.totalMs - left.totalMs);

    return {
        enabled,
        activeScenario,
        metrics: metricList,
        recentEvents: [...recentEvents],
    };
}

function shouldCollect() {
    ensureInitialized();
    return enabled;
}

function recordEvent(
    name: string,
    durationMs: number | null,
    meta?: PerfMeta,
) {
    const metric = metrics.get(name) ?? {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        lastMs: 0,
        numericTotals: {},
        lastMeta: {},
        updatedAt: 0,
    };

    const normalizedMeta: Record<string, string | number | boolean | null> = {};
    if (meta) {
        for (const [key, value] of Object.entries(meta)) {
            if (typeof value === "number" && Number.isFinite(value)) {
                metric.numericTotals[key] =
                    (metric.numericTotals[key] ?? 0) + value;
                normalizedMeta[key] = value;
            } else if (value !== undefined) {
                const normalized = stringifyMetaValue(value);
                metric.lastMeta[key] = normalized;
                normalizedMeta[key] = normalized;
            }
        }
    }

    metric.count += 1;
    if (durationMs !== null) {
        metric.totalMs += durationMs;
        metric.lastMs = durationMs;
        metric.maxMs = Math.max(metric.maxMs, durationMs);
    }
    metric.updatedAt = Date.now();
    metrics.set(name, metric);

    recentEvents.push({
        name,
        durationMs,
        meta: normalizedMeta,
        at: metric.updatedAt,
        scenario: activeScenario,
    });

    if (recentEvents.length > MAX_EVENTS) {
        recentEvents.splice(0, recentEvents.length - MAX_EVENTS);
    }
}

export function perfNow() {
    return shouldCollect() ? performance.now() : null;
}

export function perfMeasure(
    name: string,
    startMs: number | null,
    meta?: PerfMeta,
) {
    if (startMs === null || !shouldCollect()) return;
    recordEvent(name, performance.now() - startMs, meta);
}

export function perfCount(name: string, meta?: PerfMeta) {
    if (!shouldCollect()) return;
    recordEvent(name, null, meta);
}

declare global {
    interface Window {
        __vaultAiPerf?: PerfApi;
    }
}

ensureInitialized();
