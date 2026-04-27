import {
    perfCount,
    perfEnabled,
    perfMeasure,
} from "../../app/utils/perfInstrumentation";

type GraphPerfMetaValue = string | number | boolean | null | undefined;
type GraphPerfMeta = Record<string, GraphPerfMetaValue>;

const encoder = new TextEncoder();
const activeFpsSamples = new Map<string, number>();

function cleanMeta(meta: GraphPerfMeta | undefined) {
    if (!meta) return undefined;
    return Object.fromEntries(
        Object.entries(meta).filter(([, value]) => value !== undefined),
    );
}

export function graphPayloadBytes(value: unknown): number | undefined {
    if (!perfEnabled()) return undefined;
    try {
        return encoder.encode(JSON.stringify(value)).length;
    } catch {
        return undefined;
    }
}

export function graphPerfCount(name: string, meta?: GraphPerfMeta) {
    perfCount(name, cleanMeta(meta));
}

export function graphPerfMeasure(
    name: string,
    startMs: number | null,
    meta?: GraphPerfMeta,
) {
    perfMeasure(name, startMs, cleanMeta(meta));
}

export function scheduleGraphFpsSample(
    name: string,
    meta?: GraphPerfMeta,
    options?: { sampleMs?: number; cooldownMs?: number },
) {
    if (!perfEnabled()) return;

    const sampleMs = options?.sampleMs ?? 1200;
    const cooldownMs = options?.cooldownMs ?? 1600;
    const now = performance.now();
    const nextAllowedAt = activeFpsSamples.get(name) ?? 0;
    if (now < nextAllowedAt) {
        return;
    }

    activeFpsSamples.set(name, now + cooldownMs);

    let frames = 0;
    let rafId = 0;
    const startedAt = performance.now();

    const tick = (frameNow: number) => {
        frames += 1;
        const elapsed = frameNow - startedAt;
        if (elapsed >= sampleMs) {
            const fps = frames / (elapsed / 1000);
            graphPerfCount(name, {
                ...meta,
                fps: Number(fps.toFixed(1)),
                frames,
                sampleMs: Math.round(elapsed),
            });
            return;
        }
        rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
}
