import {
    buildGraphNeighborMap,
    toGraphRenderSnapshot,
    type GraphRenderSnapshot,
} from "./graphRenderModel";
import { prepareGraphLayoutWithCachedPositions } from "./graphLayout";
import type { GraphNodePosition } from "./graphLayoutCache";
import type { GraphLayoutStrategy } from "./graphSettingsStore";
import type { GraphData, GraphNodeDto, GraphSnapshotDto } from "./useGraphData";

export interface GraphPreparedPipeline {
    preparedKey: string;
    snapshot: GraphRenderSnapshot;
    restoredFromCache: boolean;
    neighborIndex: Record<string, string[]>;
}

export interface GraphPipelineWorkerRequest {
    requestId: number;
    preparedKey: string;
    snapshot: GraphSnapshotDto;
    layoutStrategy: GraphLayoutStrategy;
    cachedPositions: Record<string, GraphNodePosition> | null;
}

export interface GraphPipelineWorkerResponse {
    requestId: number;
    result?: GraphPreparedPipeline;
    error?: string;
}

function mapSnapshotNode(node: GraphNodeDto): GraphData["nodes"][number] {
    return {
        id: node.id,
        title: node.title,
        nodeType: node.node_type,
        hopDistance: node.hop_distance,
        groupColor: node.group_color,
        isRoot: node.is_root,
        importance: node.importance,
        clusterFilter: node.cluster_filter,
    };
}

export function transformSnapshot(snapshot: GraphSnapshotDto): GraphData {
    return {
        version: snapshot.version,
        mode: snapshot.mode,
        stats: {
            totalNodes: snapshot.stats.total_nodes,
            totalLinks: snapshot.stats.total_links,
            truncated: snapshot.stats.truncated,
            clusterCount: snapshot.stats.cluster_count,
        },
        nodes: snapshot.nodes.map(mapSnapshotNode),
        links: snapshot.links,
    };
}

export function runGraphPipeline(
    request: GraphPipelineWorkerRequest,
): GraphPreparedPipeline {
    const graphData = transformSnapshot(request.snapshot);
    const renderSnapshot = toGraphRenderSnapshot(graphData);
    const preparedLayout = prepareGraphLayoutWithCachedPositions(
        renderSnapshot,
        request.layoutStrategy,
        request.cachedPositions,
    );
    const neighborMap = buildGraphNeighborMap(preparedLayout.snapshot);
    const neighborIndex: Record<string, string[]> = {};

    for (const [nodeId, neighbors] of neighborMap) {
        neighborIndex[nodeId] = Array.from(neighbors);
    }

    return {
        preparedKey: request.preparedKey,
        snapshot: preparedLayout.snapshot,
        restoredFromCache: preparedLayout.restoredFromCache,
        neighborIndex,
    };
}
