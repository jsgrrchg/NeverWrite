import { useEffect, useRef, useState } from "react";
import { useVaultStore } from "../../app/store/vaultStore";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { parseQuery } from "../search/queryParser";
import {
    type AdvancedSearchParams,
    toAdvancedSearchParams,
} from "../search/queryToParams";
import { useGraphSettingsStore, type GraphMode } from "./graphSettingsStore";
import {
    graphPayloadBytes,
    graphPerfCount,
    graphPerfMeasure,
    graphPerfMeasureCompute,
} from "./graphPerf";

export type GraphNodeType = "note" | "tag" | "attachment" | "cluster";

export interface GraphNode {
    id: string;
    title: string;
    nodeType?: GraphNodeType;
    hopDistance?: number;
    groupColor?: string;
    isRoot?: boolean;
    importance?: number;
    clusterFilter?: string;
}

export interface GraphLink {
    source: string;
    target: string;
}

export interface GraphSnapshotStats {
    totalNodes: number;
    totalLinks: number;
    truncated: boolean;
    clusterCount?: number;
}

export interface GraphData {
    version: number;
    mode: "global" | "local" | "overview";
    stats: GraphSnapshotStats;
    nodes: GraphNode[];
    links: GraphLink[];
}

interface GraphNodeDto {
    id: string;
    title: string;
    node_type?: GraphNodeType;
    hop_distance?: number;
    group_color?: string;
    is_root?: boolean;
    importance?: number;
    cluster_filter?: string;
}

interface GraphSnapshotDto {
    version: number;
    mode: "global" | "local" | "overview";
    stats: {
        total_nodes: number;
        total_links: number;
        truncated: boolean;
        cluster_count?: number;
    };
    nodes: GraphNodeDto[];
    links: GraphLink[];
}

interface GraphGroupQueryDto {
    color: string;
    params: AdvancedSearchParams;
}

interface GraphSnapshotOptions {
    mode: "global" | "overview" | "local";
    root_note_id?: string;
    local_depth?: number;
    preferred_node_ids?: string[];
    include_tags: boolean;
    include_attachments: boolean;
    include_groups: boolean;
    group_queries?: GraphGroupQueryDto[];
    search_filter?: AdvancedSearchParams;
    show_orphans: boolean;
    max_nodes?: number;
    max_links?: number;
}

const THROTTLE_MS = 2000;

interface GraphLimitSettings {
    maxNodes: number;
    maxLinks: number;
}

function getGraphLimits(
    mode: GraphMode,
    limits: {
        global: GraphLimitSettings;
        overview: GraphLimitSettings;
        local: GraphLimitSettings;
    },
): GraphLimitSettings {
    switch (mode) {
        case "local":
            return limits.local;
        case "overview":
            return limits.overview;
        default:
            return limits.global;
    }
}

function transformSnapshot(result: GraphSnapshotDto): GraphData {
    return graphPerfMeasureCompute(
        "graph.data.transform.snapshot",
        () => ({
            version: result.version,
            mode: result.mode,
            stats: {
                totalNodes: result.stats.total_nodes,
                totalLinks: result.stats.total_links,
                truncated: result.stats.truncated,
                clusterCount: result.stats.cluster_count,
            },
            nodes: result.nodes.map((node) => ({
                id: node.id,
                title: node.title,
                nodeType: node.node_type,
                hopDistance: node.hop_distance,
                groupColor: node.group_color,
                isRoot: node.is_root,
                importance: node.importance,
                clusterFilter: node.cluster_filter,
            })),
            links: result.links,
        }),
        (value) => ({
            mode: value.mode,
            nodeCount: value.nodes.length,
            linkCount: value.links.length,
        }),
    );
}

function buildAdvancedParams(query: string): AdvancedSearchParams | undefined {
    const trimmed = query.trim();
    if (!trimmed) return undefined;
    return toAdvancedSearchParams(parseQuery(trimmed));
}

export function useGraphData(activeNoteId: string | null): GraphData | null {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const graphRevision = useVaultStore((s) => s.graphRevision);
    const graphMode = useGraphSettingsStore((s) => s.graphMode);
    const localDepth = useGraphSettingsStore((s) => s.localDepth);
    const searchFilter = useGraphSettingsStore((s) => s.searchFilter);
    const showOrphans = useGraphSettingsStore((s) => s.showOrphans);
    const showTagNodes = useGraphSettingsStore((s) => s.showTagNodes);
    const showAttachmentNodes = useGraphSettingsStore(
        (s) => s.showAttachmentNodes,
    );
    const groups = useGraphSettingsStore((s) => s.groups);
    const maxGlobalNodes = useGraphSettingsStore((s) => s.maxGlobalNodes);
    const maxGlobalLinks = useGraphSettingsStore((s) => s.maxGlobalLinks);
    const maxOverviewNodes = useGraphSettingsStore((s) => s.maxOverviewNodes);
    const maxOverviewLinks = useGraphSettingsStore((s) => s.maxOverviewLinks);
    const maxLocalNodes = useGraphSettingsStore((s) => s.maxLocalNodes);
    const maxLocalLinks = useGraphSettingsStore((s) => s.maxLocalLinks);

    const [data, setData] = useState<GraphData | null>(null);
    const [debouncedSearchFilter, setDebouncedSearchFilter] = useState("");
    const lastFetchRef = useRef(0);
    const pendingRef = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined,
    );
    const missingLocalRoot = graphMode === "local" && !activeNoteId;

    useEffect(() => {
        const timer = setTimeout(
            () => setDebouncedSearchFilter(searchFilter.trim()),
            300,
        );
        return () => clearTimeout(timer);
    }, [searchFilter]);

    useEffect(() => {
        if (!vaultPath) return;
        if (missingLocalRoot) return;

        const limits = getGraphLimits(graphMode, {
            global: {
                maxNodes: maxGlobalNodes,
                maxLinks: maxGlobalLinks,
            },
            overview: {
                maxNodes: maxOverviewNodes,
                maxLinks: maxOverviewLinks,
            },
            local: {
                maxNodes: maxLocalNodes,
                maxLinks: maxLocalLinks,
            },
        });

        const groupQueries = groups
            .filter((group) => group.query.trim())
            .map(
                (group): GraphGroupQueryDto => ({
                    color: group.color,
                    params: toAdvancedSearchParams(parseQuery(group.query)),
                }),
            );
        const searchParams = buildAdvancedParams(debouncedSearchFilter);

        let cancelled = false;

        const doFetch = async () => {
            const pipelineStartMs = performance.now();
            lastFetchRef.current = Date.now();

            try {
                const options: GraphSnapshotOptions = {
                    mode: graphMode,
                    root_note_id:
                        graphMode === "local"
                            ? (activeNoteId ?? undefined)
                            : undefined,
                    local_depth: graphMode === "local" ? localDepth : undefined,
                    preferred_node_ids: activeNoteId
                        ? [activeNoteId]
                        : undefined,
                    include_tags: showTagNodes,
                    include_attachments: showAttachmentNodes,
                    include_groups: groupQueries.length > 0,
                    group_queries:
                        groupQueries.length > 0 ? groupQueries : undefined,
                    search_filter: searchParams,
                    show_orphans: showOrphans,
                    max_nodes: limits.maxNodes,
                    max_links: limits.maxLinks,
                };

                const fetchStartMs = performance.now();
                const snapshot = await vaultInvoke<GraphSnapshotDto>(
                    "get_graph_snapshot",
                    { options },
                );
                graphPerfMeasure(
                    "graph.data.fetch.snapshot.duration",
                    fetchStartMs,
                    {
                        mode: snapshot.mode,
                        totalNodeCount: snapshot.stats.total_nodes,
                        totalLinkCount: snapshot.stats.total_links,
                        visibleNodeCount: snapshot.nodes.length,
                        visibleLinkCount: snapshot.links.length,
                        truncated: snapshot.stats.truncated,
                        payloadBytes: graphPayloadBytes(snapshot),
                        showTagNodes,
                        showAttachmentNodes,
                        groupCount: groupQueries.length,
                        filtered: Boolean(searchParams),
                        showOrphans,
                    },
                );
                graphPerfCount("graph.data.fetch.snapshot", {
                    mode: snapshot.mode,
                    totalNodeCount: snapshot.stats.total_nodes,
                    totalLinkCount: snapshot.stats.total_links,
                    visibleNodeCount: snapshot.nodes.length,
                    visibleLinkCount: snapshot.links.length,
                    truncated: snapshot.stats.truncated,
                    payloadBytes: graphPayloadBytes(snapshot),
                    groupCount: groupQueries.length,
                    filtered: Boolean(searchParams),
                });

                const result = transformSnapshot(snapshot);
                if (cancelled) return;

                graphPerfMeasure(
                    "graph.data.pipeline.duration",
                    pipelineStartMs,
                    {
                        mode: result.mode,
                        nodeCount: result.nodes.length,
                        linkCount: result.links.length,
                        showTagNodes,
                        showAttachmentNodes,
                        localDepth:
                            result.mode === "local" ? localDepth : undefined,
                        groupCount: groupQueries.length,
                        filtered: Boolean(searchParams),
                        showOrphans,
                        payloadBytes: graphPayloadBytes(result),
                    },
                );
                graphPerfCount("graph.data.pipeline.completed", {
                    mode: result.mode,
                    nodeCount: result.nodes.length,
                    linkCount: result.links.length,
                    showTagNodes,
                    showAttachmentNodes,
                    groupCount: groupQueries.length,
                    filtered: Boolean(searchParams),
                });
                setData(result);
            } catch (error) {
                if (cancelled) return;
                graphPerfCount("graph.data.pipeline.error", {
                    mode: graphMode,
                    message:
                        error instanceof Error ? error.message : String(error),
                    showTagNodes,
                    showAttachmentNodes,
                });
                console.error("Error fetching graph data:", error);
            }
        };

        const elapsed = Date.now() - lastFetchRef.current;
        if (elapsed >= THROTTLE_MS) {
            void doFetch();
        } else {
            clearTimeout(pendingRef.current);
            pendingRef.current = setTimeout(
                () => void doFetch(),
                THROTTLE_MS - elapsed,
            );
        }

        return () => {
            cancelled = true;
            clearTimeout(pendingRef.current);
        };
    }, [
        vaultPath,
        graphRevision,
        graphMode,
        localDepth,
        activeNoteId,
        missingLocalRoot,
        debouncedSearchFilter,
        maxGlobalLinks,
        maxGlobalNodes,
        maxLocalLinks,
        maxLocalNodes,
        maxOverviewLinks,
        maxOverviewNodes,
        showOrphans,
        showTagNodes,
        showAttachmentNodes,
        groups,
    ]);

    return missingLocalRoot ? null : data;
}
