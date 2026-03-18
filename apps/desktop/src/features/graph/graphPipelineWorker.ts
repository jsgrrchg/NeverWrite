/// <reference lib="webworker" />

import {
    runGraphPipeline,
    type GraphPipelineWorkerRequest,
    type GraphPipelineWorkerResponse,
} from "./graphPipeline";

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.addEventListener(
    "message",
    (event: MessageEvent<GraphPipelineWorkerRequest>) => {
        const { requestId } = event.data;

        try {
            const result = runGraphPipeline(event.data);
            const response: GraphPipelineWorkerResponse = {
                requestId,
                result,
            };
            workerScope.postMessage(response);
        } catch (error) {
            const response: GraphPipelineWorkerResponse = {
                requestId,
                error: error instanceof Error ? error.message : String(error),
            };
            workerScope.postMessage(response);
        }
    },
);

export {};
