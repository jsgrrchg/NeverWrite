import {
    loadGraphLayoutSnapshot,
    type GraphNodePosition,
} from "./graphLayoutCache";
import type {
    GraphPosition,
    GraphRenderNode,
    GraphRenderSnapshot,
} from "./graphRenderModel";
import type { GraphLayoutStrategy } from "./graphSettingsStore";
import { withGraphPositions } from "./graphRenderModel";

export interface PreparedGraphLayout {
    snapshot: GraphRenderSnapshot;
    restoredFromCache: boolean;
}

function buildOverviewPackedPositions(
    nodes: GraphRenderNode[],
): Record<string, GraphPosition> {
    const positions: Record<string, GraphPosition> = {};
    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const radius = 24 * Math.sqrt(index + 1);
        const angle = index * 2.399963229728653;
        positions[node.id] = {
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius,
        };
    }
    return positions;
}

function buildClusteredPositions(
    nodes: GraphRenderNode[],
): Record<string, GraphPosition> {
    const clusters = new Map<string, GraphRenderNode[]>();
    for (const node of nodes) {
        const clusterKey = node.isRoot
            ? "root"
            : node.groupColor
              ? `group:${node.groupColor}`
              : node.nodeType
                ? `type:${node.nodeType}`
                : node.hopDistance != null
                  ? `hop:${node.hopDistance}`
                  : "notes";
        const bucket = clusters.get(clusterKey);
        if (bucket) {
            bucket.push(node);
        } else {
            clusters.set(clusterKey, [node]);
        }
    }

    const clusterEntries = Array.from(clusters.entries());
    const clusterRadius = Math.max(180, clusterEntries.length * 48);
    const positions: Record<string, GraphPosition> = {};

    clusterEntries.forEach(([, clusterNodes], clusterIndex) => {
        const centerAngle =
            (clusterIndex / Math.max(clusterEntries.length, 1)) * Math.PI * 2;
        const center = {
            x: Math.cos(centerAngle) * clusterRadius,
            y: Math.sin(centerAngle) * clusterRadius,
        };

        clusterNodes.forEach((node, nodeIndex) => {
            const radius = 18 * Math.sqrt(nodeIndex + 1);
            const angle = nodeIndex * 2.399963229728653;
            positions[node.id] = {
                x: center.x + Math.cos(angle) * radius,
                y: center.y + Math.sin(angle) * radius,
            };
        });
    });

    return positions;
}

export function prepareGraphLayout(
    snapshot: GraphRenderSnapshot,
    layoutKey: string,
    layoutStrategy: GraphLayoutStrategy,
): PreparedGraphLayout {
    const cachedLayout = loadGraphLayoutSnapshot(layoutKey);
    return prepareGraphLayoutWithCachedPositions(
        snapshot,
        layoutStrategy,
        cachedLayout?.positions ?? null,
    );
}

export function prepareGraphLayoutWithCachedPositions(
    snapshot: GraphRenderSnapshot,
    layoutStrategy: GraphLayoutStrategy,
    cachedPositions: Record<string, GraphNodePosition> | null,
): PreparedGraphLayout {
    const fallbackPositions =
        layoutStrategy === "overview-packed"
            ? buildOverviewPackedPositions(snapshot.nodes)
            : layoutStrategy === "clustered"
              ? buildClusteredPositions(snapshot.nodes)
              : null;
    const positions = cachedPositions ?? fallbackPositions ?? null;

    return {
        snapshot: withGraphPositions(snapshot, positions),
        restoredFromCache: Boolean(cachedPositions),
    };
}

export function extractGraphPositions(
    nodes: GraphRenderNode[],
): Record<string, GraphNodePosition> {
    const positions: Record<string, GraphNodePosition> = {};
    for (const node of nodes) {
        if (!node.position) continue;
        positions[node.id] = {
            x: node.position.x,
            y: node.position.y,
        };
    }
    return positions;
}
