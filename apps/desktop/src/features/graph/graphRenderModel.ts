import type { GraphMode, GraphQualityMode } from "./graphSettingsStore";
import type { GraphData, GraphNodeType } from "./useGraphData";

export type GraphRenderNodeType = GraphNodeType;

export interface GraphPosition {
    x: number;
    y: number;
    z?: number;
}

export interface GraphRenderNode {
    id: string;
    title: string;
    nodeType: GraphRenderNodeType;
    importance: number;
    hopDistance?: number;
    groupColor?: string;
    clusterId?: string;
    clusterFilter?: string;
    isRoot?: boolean;
    position?: GraphPosition;
}

export interface GraphRenderLink {
    source: string;
    target: string;
}

export interface GraphRenderStats {
    totalNodes: number;
    totalLinks: number;
    truncated: boolean;
    clusterCount?: number;
}

export interface GraphRenderSnapshot {
    version: number;
    mode: GraphMode;
    stats: GraphRenderStats;
    nodes: GraphRenderNode[];
    links: GraphRenderLink[];
}

export interface GraphRendererSelectionState {
    hoveredNodeId: string | null;
    activeNodeId: string | null;
    selectedNodeId: string | null;
    highlightedNeighborIds: ReadonlySet<string>;
}

export interface GraphRendererCallbacks {
    onNodeClick?: (node: GraphRenderNode) => void;
    onNodeContextMenu?: (node: GraphRenderNode, event: MouseEvent) => void;
    onNodeHover?: (nodeId: string | null) => void;
    onBackgroundClick?: () => void;
    onSelectionChange?: (nodeId: string | null) => void;
    onQualityModeChange?: (mode: GraphQualityMode) => void;
    onHighlightNeighbors?: (nodeId: string | null) => void;
    onPersistPositions?: (positions: Record<string, GraphPosition>) => void;
}

export interface GraphRendererHandle {
    focusNode: (nodeId: string) => void;
    fitGraph: (durationMs?: number, paddingPx?: number) => void;
    setSelection: (nodeId: string | null) => void;
    setQualityMode: (mode: GraphQualityMode) => void;
    highlightNeighbors: (nodeId: string | null) => void;
}

export function toGraphRenderSnapshot(data: GraphData): GraphRenderSnapshot {
    return {
        version: data.version,
        mode: data.mode,
        stats: data.stats,
        nodes: data.nodes.map((node) => ({
            id: node.id,
            title: node.title,
            nodeType: node.nodeType ?? "note",
            importance: Math.max(1, node.importance ?? 1),
            hopDistance: node.hopDistance,
            groupColor: node.groupColor,
            clusterFilter: node.clusterFilter,
            isRoot: node.isRoot,
        })),
        links: data.links.map((link) => ({
            source: link.source,
            target: link.target,
        })),
    };
}

export function buildGraphNeighborMap(
    snapshot: GraphRenderSnapshot,
): Map<string, Set<string>> {
    const neighbors = new Map<string, Set<string>>();
    for (const link of snapshot.links) {
        const sourceSet = neighbors.get(link.source);
        if (sourceSet) {
            sourceSet.add(link.target);
        } else {
            neighbors.set(link.source, new Set([link.target]));
        }

        const targetSet = neighbors.get(link.target);
        if (targetSet) {
            targetSet.add(link.source);
        } else {
            neighbors.set(link.target, new Set([link.source]));
        }
    }
    return neighbors;
}

export function withGraphPositions(
    snapshot: GraphRenderSnapshot,
    positions: Record<string, GraphPosition> | null,
): GraphRenderSnapshot {
    if (!positions) return snapshot;
    return {
        ...snapshot,
        nodes: snapshot.nodes.map((node) => ({
            ...node,
            position: positions[node.id] ?? node.position,
        })),
    };
}
