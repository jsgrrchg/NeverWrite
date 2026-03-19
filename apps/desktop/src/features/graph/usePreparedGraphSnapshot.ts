import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { loadGraphLayoutSnapshot } from "./graphLayoutCache";
import {
    graphPayloadBytes,
    graphPerfCount,
    graphPerfMeasure,
} from "./graphPerf";
import type { GraphLayoutStrategy } from "./graphSettingsStore";
import type {
    GraphPreparedPipeline,
    GraphPipelineWorkerResponse,
} from "./graphPipeline";
import type { GraphSnapshotDto } from "./useGraphData";

interface UsePreparedGraphSnapshotOptions {
    graphSnapshot: GraphSnapshotDto | null;
    layoutKey: string | null;
    layoutStrategy: GraphLayoutStrategy;
    isVisible: boolean;
}

interface UsePreparedGraphSnapshotResult {
    prepared: GraphPreparedPipeline | null;
    isPreparing: boolean;
    error: string | null;
}

export function usePreparedGraphSnapshot({
    graphSnapshot,
    layoutKey,
    layoutStrategy,
    isVisible,
}: UsePreparedGraphSnapshotOptions): UsePreparedGraphSnapshotResult {
    const workerRef = useRef<Worker | null>(null);
    const requestIdRef = useRef(0);
    const latestRequestIdRef = useRef(0);
    const requestMetaRef = useRef<
        Map<
            number,
            {
                startMs: number;
                snapshot: GraphSnapshotDto;
                layoutKey: string;
                restoredFromCache: boolean;
            }
        >
    >(new Map());
    const [prepared, setPrepared] = useState<GraphPreparedPipeline | null>(
        null,
    );
    const [isPreparing, setIsPreparing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const cachedPositions = useMemo(
        () =>
            layoutKey
                ? (loadGraphLayoutSnapshot(layoutKey)?.positions ?? null)
                : null,
        [layoutKey],
    );

    useEffect(() => {
        const worker = new Worker(
            new URL("./graphPipelineWorker.ts", import.meta.url),
            { type: "module" },
        );
        workerRef.current = worker;

        const handleMessage = (
            event: MessageEvent<GraphPipelineWorkerResponse>,
        ) => {
            const response = event.data;
            const meta = requestMetaRef.current.get(response.requestId);
            requestMetaRef.current.delete(response.requestId);
            if (response.requestId !== latestRequestIdRef.current || !meta) {
                return;
            }

            setIsPreparing(false);

            if (response.error || !response.result) {
                const message =
                    response.error ?? "Unknown graph pipeline error";
                setError(message);
                graphPerfCount("graph.data.pipeline.worker.error", {
                    mode: meta.snapshot.mode,
                    nodeCount: meta.snapshot.nodes.length,
                    linkCount: meta.snapshot.links.length,
                    restoredLayout: meta.restoredFromCache ? 1 : 0,
                    message,
                });
                return;
            }

            graphPerfMeasure(
                "graph.data.pipeline.worker.duration",
                meta.startMs,
                {
                    mode: meta.snapshot.mode,
                    nodeCount: response.result.snapshot.nodes.length,
                    linkCount: response.result.snapshot.links.length,
                    restoredLayout: response.result.restoredFromCache ? 1 : 0,
                    payloadBytes: graphPayloadBytes(response.result.snapshot),
                },
            );
            graphPerfCount("graph.data.pipeline.worker.completed", {
                mode: meta.snapshot.mode,
                nodeCount: response.result.snapshot.nodes.length,
                linkCount: response.result.snapshot.links.length,
                restoredLayout: response.result.restoredFromCache ? 1 : 0,
            });

            setError(null);
            startTransition(() => {
                setPrepared(response.result ?? null);
            });
        };

        const handleError = (event: ErrorEvent) => {
            setIsPreparing(false);
            setError(event.message || "Unknown graph worker error");
        };

        worker.addEventListener("message", handleMessage);
        worker.addEventListener("error", handleError);

        return () => {
            worker.removeEventListener("message", handleMessage);
            worker.removeEventListener("error", handleError);
            worker.terminate();
            workerRef.current = null;
            requestMetaRef.current.clear();
        };
    }, []);

    useEffect(() => {
        if (!graphSnapshot || !layoutKey) {
            setIsPreparing(false);
            setError(null);
            startTransition(() => {
                setPrepared(null);
            });
            return;
        }

        if (!isVisible) {
            return;
        }

        if (prepared?.layoutKey === layoutKey) {
            setIsPreparing(false);
            setError(null);
            return;
        }

        const worker = workerRef.current;
        if (!worker) return;

        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        latestRequestIdRef.current = requestId;
        requestMetaRef.current.set(requestId, {
            startMs: performance.now(),
            snapshot: graphSnapshot,
            layoutKey,
            restoredFromCache: cachedPositions != null,
        });

        setIsPreparing(true);
        setError(null);

        worker.postMessage({
            requestId,
            layoutKey,
            snapshot: graphSnapshot,
            layoutStrategy,
            cachedPositions,
        });
    }, [
        cachedPositions,
        graphSnapshot,
        isVisible,
        layoutKey,
        layoutStrategy,
        prepared,
    ]);

    return {
        prepared,
        isPreparing,
        error,
    };
}
