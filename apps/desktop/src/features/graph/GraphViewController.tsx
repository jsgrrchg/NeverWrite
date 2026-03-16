import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    useEditorStore,
    isNoteTab,
    type NoteTab,
} from "../../app/store/editorStore";
import { useThemeStore } from "../../app/store/themeStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { revealNoteInTree } from "../../app/utils/navigation";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    GraphContextMenu,
    type GraphContextMenuState,
} from "./GraphContextMenu";
import { GraphRenderer3D } from "./GraphRenderer3D";
import { GraphRenderer2D } from "./GraphRenderer2D";
import { GraphSettingsPanel } from "./GraphSettingsPanel";
import { prepareGraphLayout } from "./graphLayout";
import {
    buildGraphLayoutKey,
    saveGraphLayoutSnapshot,
    type GraphNodePosition,
} from "./graphLayoutCache";
import { qualityProfileForMode, resolveQualityMode } from "./graphQuality";
import {
    buildGraphNeighborMap,
    toGraphRenderSnapshot,
    type GraphPosition,
    type GraphRenderNode,
    type GraphRendererCallbacks,
    type GraphRendererHandle,
    type GraphRendererSelectionState,
} from "./graphRenderModel";
import {
    useGraphSettingsStore,
    type GraphMode,
    type GraphQualityMode,
} from "./graphSettingsStore";
import { useGraphData } from "./useGraphData";

const GRAPH_NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const LARGE_GRAPH_SUGGESTION_THRESHOLD = 10_000;

function parseHexRgb(hex: string): [number, number, number] {
    if (hex.startsWith("#") && hex.length >= 7) {
        return [
            parseInt(hex.slice(1, 3), 16),
            parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16),
        ];
    }
    return [160, 160, 180];
}

function toGraphNodePositions(
    positions: Record<string, GraphPosition>,
): Record<string, GraphNodePosition> {
    const next: Record<string, GraphNodePosition> = {};
    for (const [nodeId, position] of Object.entries(positions)) {
        next[nodeId] = { x: position.x, y: position.y, z: position.z };
    }
    return next;
}

export function GraphViewController() {
    const rendererRef = useRef<GraphRendererHandle | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [highlightedNeighborIds, setHighlightedNeighborIds] = useState<
        ReadonlySet<string>
    >(new Set());
    const [contextMenu, setContextMenu] =
        useState<GraphContextMenuState | null>(null);

    const activeNoteId = useEditorStore((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        return tab && isNoteTab(tab) ? tab.noteId : null;
    });
    const vaultPath = useVaultStore((s) => s.vaultPath);

    const graphMode = useGraphSettingsStore((s) => s.graphMode);
    const rendererMode = useGraphSettingsStore((s) => s.rendererMode);
    const localDepth = useGraphSettingsStore((s) => s.localDepth);
    const qualityModeSetting = useGraphSettingsStore((s) => s.qualityMode);
    const layoutStrategy = useGraphSettingsStore((s) => s.layoutStrategy);
    const searchFilter = useGraphSettingsStore((s) => s.searchFilter);
    const showOrphans = useGraphSettingsStore((s) => s.showOrphans);
    const showTagNodes = useGraphSettingsStore((s) => s.showTagNodes);
    const showAttachmentNodes = useGraphSettingsStore(
        (s) => s.showAttachmentNodes,
    );
    const defaultModeByVault = useGraphSettingsStore(
        (s) => s.defaultModeByVault,
    );
    const maxGlobalNodes = useGraphSettingsStore((s) => s.maxGlobalNodes);
    const maxOverviewNodes = useGraphSettingsStore((s) => s.maxOverviewNodes);
    const maxLocalNodes = useGraphSettingsStore((s) => s.maxLocalNodes);

    const centerForce = useGraphSettingsStore((s) => s.centerForce);
    const repelForce = useGraphSettingsStore((s) => s.repelForce);
    const linkForce = useGraphSettingsStore((s) => s.linkForce);
    const linkDistance = useGraphSettingsStore((s) => s.linkDistance);
    const nodeSize = useGraphSettingsStore((s) => s.nodeSize);
    const linkThickness = useGraphSettingsStore((s) => s.linkThickness);
    const textFadeThreshold = useGraphSettingsStore((s) => s.textFadeThreshold);
    const arrows = useGraphSettingsStore((s) => s.arrows);
    const glowIntensity = useGraphSettingsStore((s) => s.glowIntensity);
    const setGraphSetting = useGraphSettingsStore((s) => s.set);

    const rawData = useGraphData(activeNoteId);
    const renderSnapshot = useMemo(
        () => (rawData ? toGraphRenderSnapshot(rawData) : null),
        [rawData],
    );
    const effectiveQualityMode = useMemo(
        () =>
            resolveQualityMode(
                qualityModeSetting,
                renderSnapshot?.stats.totalNodes ??
                    renderSnapshot?.nodes.length ??
                    0,
            ),
        [qualityModeSetting, renderSnapshot],
    );
    const qualityProfile = useMemo(
        () => qualityProfileForMode(effectiveQualityMode),
        [effectiveQualityMode],
    );

    const isDark = useThemeStore((s) => s.isDark);
    const canvasTheme = useMemo(() => {
        const style = getComputedStyle(document.documentElement);
        const get = (name: string) => style.getPropertyValue(name).trim();
        return {
            labelRgb: parseHexRgb(get("--text-secondary")),
            linkColor: isDark
                ? `rgba(255, 255, 255, ${0.06 * qualityProfile.linkColorAlpha})`
                : `rgba(0, 0, 0, ${0.07 * qualityProfile.linkColorAlpha})`,
            particleColor:
                qualityProfile.particleCount > 0
                    ? isDark
                        ? "rgba(99, 102, 241, 0.35)"
                        : "rgba(99, 102, 241, 0.25)"
                    : "rgba(0, 0, 0, 0)",
        };
    }, [isDark, qualityProfile]);

    const truncationMessage = useMemo(() => {
        if (!renderSnapshot?.stats.truncated) return null;

        const visibleNodes = GRAPH_NUMBER_FORMAT.format(
            renderSnapshot.nodes.length,
        );
        const visibleLinks = GRAPH_NUMBER_FORMAT.format(
            renderSnapshot.links.length,
        );
        const totalNodes = GRAPH_NUMBER_FORMAT.format(
            renderSnapshot.stats.totalNodes,
        );
        const totalLinks = GRAPH_NUMBER_FORMAT.format(
            renderSnapshot.stats.totalLinks,
        );

        if (
            renderSnapshot.stats.totalNodes > renderSnapshot.nodes.length ||
            renderSnapshot.stats.totalLinks > renderSnapshot.links.length
        ) {
            return {
                title: `Showing ${visibleNodes} of ${totalNodes} nodes`,
                detail: `Visible links: ${visibleLinks} of ${totalLinks}`,
            };
        }

        return {
            title: `Showing a truncated graph (${visibleNodes} nodes)`,
            detail: `Visible links: ${visibleLinks}`,
        };
    }, [renderSnapshot]);

    const hiddenNodeCount = Math.max(
        0,
        (renderSnapshot?.stats.totalNodes ?? 0) -
            (renderSnapshot?.nodes.length ?? 0),
    );
    const hiddenLinkCount = Math.max(
        0,
        (renderSnapshot?.stats.totalLinks ?? 0) -
            (renderSnapshot?.links.length ?? 0),
    );
    const graphStatusMessage = useMemo(() => {
        if (!renderSnapshot) return null;
        const visibleNodes = GRAPH_NUMBER_FORMAT.format(
            renderSnapshot.nodes.length,
        );
        const visibleLinks = GRAPH_NUMBER_FORMAT.format(
            renderSnapshot.links.length,
        );

        if (hiddenNodeCount > 0 || hiddenLinkCount > 0) {
            return {
                title: `${visibleNodes} nodes • ${visibleLinks} links visible`,
                detail: `Hidden by limits: ${GRAPH_NUMBER_FORMAT.format(hiddenNodeCount)} nodes • ${GRAPH_NUMBER_FORMAT.format(hiddenLinkCount)} links`,
            };
        }

        return {
            title: `${visibleNodes} nodes • ${visibleLinks} links visible`,
            detail: "Showing the full graph for the current mode and filters.",
        };
    }, [hiddenLinkCount, hiddenNodeCount, renderSnapshot]);

    const layoutKey = useMemo(() => {
        if (!vaultPath || !renderSnapshot) return null;
        return buildGraphLayoutKey({
            vaultPath,
            graphVersion: renderSnapshot.version,
            graphMode,
            rendererMode,
            localDepth,
            rootNoteId: activeNoteId,
            showTagNodes,
            showAttachmentNodes,
            showOrphans,
            searchFilter: searchFilter.trim(),
            layoutStrategy,
        });
    }, [
        activeNoteId,
        graphMode,
        rendererMode,
        layoutStrategy,
        localDepth,
        renderSnapshot,
        searchFilter,
        showAttachmentNodes,
        showOrphans,
        showTagNodes,
        vaultPath,
    ]);

    const preparedLayout = useMemo(() => {
        if (!renderSnapshot || !layoutKey) return null;
        return prepareGraphLayout(renderSnapshot, layoutKey, layoutStrategy);
    }, [layoutKey, layoutStrategy, renderSnapshot]);

    const preparedSnapshot = preparedLayout?.snapshot ?? null;
    const shouldRunSimulation =
        preparedSnapshot != null &&
        (layoutStrategy === "force" ||
            (layoutStrategy === "preset" &&
                !preparedLayout?.restoredFromCache));
    const cooldownTicks = shouldRunSimulation
        ? qualityProfile.defaultCooldownTicks
        : 0;
    const appliedVaultDefaultRef = useRef<string | null>(null);

    useEffect(() => {
        if (!vaultPath) {
            appliedVaultDefaultRef.current = null;
            return;
        }
        if (appliedVaultDefaultRef.current === vaultPath) return;
        appliedVaultDefaultRef.current = vaultPath;
        const defaultMode = defaultModeByVault[vaultPath];
        if (defaultMode && defaultMode !== graphMode) {
            useGraphSettingsStore.getState().set("graphMode", defaultMode);
        }
    }, [defaultModeByVault, graphMode, vaultPath]);

    const neighborMap = useMemo(
        () =>
            preparedSnapshot
                ? buildGraphNeighborMap(preparedSnapshot)
                : new Map(),
        [preparedSnapshot],
    );

    const visibleNodeIds = useMemo(
        () =>
            preparedSnapshot
                ? new Set(preparedSnapshot.nodes.map((node) => node.id))
                : new Set<string>(),
        [preparedSnapshot],
    );

    const visibleHoveredNodeId =
        hoveredNodeId && visibleNodeIds.has(hoveredNodeId)
            ? hoveredNodeId
            : null;
    const visibleSelectedNodeId =
        selectedNodeId && visibleNodeIds.has(selectedNodeId)
            ? selectedNodeId
            : null;
    const visibleHighlightedNeighborIds = useMemo(() => {
        if (highlightedNeighborIds.size === 0) return highlightedNeighborIds;
        return new Set(
            Array.from(highlightedNeighborIds).filter((nodeId) =>
                visibleNodeIds.has(nodeId),
            ),
        );
    }, [highlightedNeighborIds, visibleNodeIds]);

    const selection = useMemo<GraphRendererSelectionState>(
        () => ({
            hoveredNodeId: visibleHoveredNodeId,
            activeNodeId: activeNoteId,
            selectedNodeId: visibleSelectedNodeId,
            highlightedNeighborIds: visibleHighlightedNeighborIds,
        }),
        [
            activeNoteId,
            visibleHighlightedNeighborIds,
            visibleHoveredNodeId,
            visibleSelectedNodeId,
        ],
    );

    const persistPositions = useCallback(
        (positions: Record<string, GraphPosition>) => {
            if (!layoutKey) return;
            saveGraphLayoutSnapshot(layoutKey, toGraphNodePositions(positions));
        },
        [layoutKey],
    );

    const openNoteById = useCallback(async (noteId: string, title: string) => {
        const { openNote, tabs } = useEditorStore.getState();
        const existing = tabs.find(
            (t): t is NoteTab => isNoteTab(t) && t.noteId === noteId,
        );
        if (existing) {
            openNote(noteId, title, existing.content);
            return;
        }
        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", {
                noteId,
            });
            openNote(noteId, title, detail.content);
        } catch (error) {
            console.error("Error opening note from graph:", error);
        }
    }, []);

    const updateHighlightedNeighbors = useCallback(
        (nodeId: string | null) => {
            if (!nodeId) {
                setHighlightedNeighborIds(new Set());
                return;
            }
            const next = new Set<string>(neighborMap.get(nodeId) ?? []);
            next.add(nodeId);
            setHighlightedNeighborIds(next);
        },
        [neighborMap],
    );

    const handleNodeClick = useCallback(
        (node: GraphRenderNode) => {
            setContextMenu(null);
            if (node.nodeType === "cluster") {
                if (!node.clusterFilter) return;
                const escapedFilter = node.clusterFilter.replaceAll('"', '\\"');
                setGraphSetting("graphMode", "global");
                setGraphSetting(
                    "searchFilter",
                    escapedFilter.includes(" ")
                        ? `path:"${escapedFilter}"`
                        : `path:${escapedFilter}`,
                );
                return;
            }
            if (node.nodeType === "tag" || node.nodeType === "attachment") {
                return;
            }
            void openNoteById(node.id, node.title || node.id);
        },
        [openNoteById, setGraphSetting],
    );

    const handleNodeContextMenu = useCallback(
        (node: GraphRenderNode, event: MouseEvent) => {
            if (node.nodeType === "cluster") return;
            event.preventDefault();
            setContextMenu({
                nodeId: node.id,
                nodeTitle: node.title || node.id,
                x: event.clientX,
                y: event.clientY,
            });
        },
        [],
    );

    const handleQualityModeChange = useCallback(
        (mode: GraphQualityMode) => {
            setGraphSetting("qualityMode", mode);
        },
        [setGraphSetting],
    );

    const rendererCallbacks = useMemo<GraphRendererCallbacks>(
        () => ({
            onNodeClick: handleNodeClick,
            onNodeContextMenu: handleNodeContextMenu,
            onNodeHover: setHoveredNodeId,
            onBackgroundClick: () => setContextMenu(null),
            onSelectionChange: setSelectedNodeId,
            onQualityModeChange: handleQualityModeChange,
            onHighlightNeighbors: updateHighlightedNeighbors,
            onPersistPositions: persistPositions,
        }),
        [
            handleNodeClick,
            handleNodeContextMenu,
            handleQualityModeChange,
            persistPositions,
            updateHighlightedNeighbors,
        ],
    );

    const handleOpenInNewTab = useCallback(
        async (noteId: string, title: string) => {
            void openNoteById(noteId, title);
        },
        [openNoteById],
    );

    const handleRevealInTree = useCallback((noteId: string) => {
        revealNoteInTree(noteId);
    }, []);

    const suggestionActions = useMemo(() => {
        if (!renderSnapshot)
            return [] as Array<{
                label: string;
                action: () => void;
            }>;

        const feelsLarge =
            renderSnapshot.stats.totalNodes >=
                LARGE_GRAPH_SUGGESTION_THRESHOLD ||
            renderSnapshot.stats.truncated;
        const actions: Array<{
            label: string;
            action: () => void;
        }> = [];

        if (graphMode === "global" && feelsLarge) {
            actions.push({
                label: "Switch to Overview",
                action: () => setGraphSetting("graphMode", "overview"),
            });
        }

        if (
            activeNoteId &&
            graphMode !== "local" &&
            (feelsLarge || graphMode === "overview")
        ) {
            actions.push({
                label: "Open Local Graph",
                action: () => setGraphSetting("graphMode", "local"),
            });
        }

        return actions.slice(0, 2);
    }, [activeNoteId, graphMode, renderSnapshot, setGraphSetting]);

    const currentLimit = useMemo(() => {
        switch (graphMode as GraphMode) {
            case "local":
                return maxLocalNodes;
            case "overview":
                return maxOverviewNodes;
            default:
                return maxGlobalNodes;
        }
    }, [graphMode, maxGlobalNodes, maxLocalNodes, maxOverviewNodes]);

    const panelOpen = useGraphSettingsStore((s) => s.panelOpen);
    const togglePanel = useGraphSettingsStore((s) => s.togglePanel);

    const settingsPanel = (
        <GraphSettingsPanel
            effectiveQualityMode={effectiveQualityMode}
            totalNodes={preparedSnapshot?.stats.totalNodes ?? null}
            vaultPath={vaultPath}
        />
    );

    const toggleButton = (
        <button
            onClick={togglePanel}
            title={panelOpen ? "Hide settings" : "Show settings"}
            style={{
                position: "absolute",
                top: 12,
                right: 12,
                zIndex: 10,
                width: 30,
                height: 30,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: panelOpen
                    ? "var(--bg-tertiary)"
                    : "var(--bg-secondary)",
                color: panelOpen ? "var(--accent)" : "var(--text-secondary)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backdropFilter: "blur(8px)",
            }}
        >
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
        </button>
    );

    if (!preparedSnapshot || !layoutKey) {
        const message =
            graphMode === "local" && !activeNoteId
                ? "Open a note to see its local graph"
                : "Loading graph…";
        return (
            <div style={{ display: "flex", position: "absolute", inset: 0 }}>
                {settingsPanel}
                <div
                    style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        position: "relative",
                        color: "var(--text-secondary)",
                        fontSize: 14,
                        background: "var(--bg-primary)",
                    }}
                >
                    {message}
                    {toggleButton}
                </div>
            </div>
        );
    }

    return (
        <div style={{ display: "flex", position: "absolute", inset: 0 }}>
            {settingsPanel}
            <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
                {rendererMode === "3d" ? (
                    <GraphRenderer3D
                        ref={rendererRef}
                        snapshot={preparedSnapshot}
                        graphMode={graphMode}
                        localDepth={localDepth}
                        qualityProfile={qualityProfile}
                        selection={selection}
                        canvasTheme={canvasTheme}
                        linkThickness={linkThickness}
                        arrows={arrows}
                        centerForce={centerForce}
                        repelForce={repelForce}
                        linkForce={linkForce}
                        linkDistance={linkDistance}
                        nodeSize={nodeSize}
                        glowIntensity={glowIntensity}
                        textFadeThreshold={textFadeThreshold}
                        layoutKey={layoutKey}
                        restoredFromCache={
                            preparedLayout?.restoredFromCache ?? false
                        }
                        shouldRunSimulation={shouldRunSimulation}
                        cooldownTicks={cooldownTicks}
                        callbacks={rendererCallbacks}
                    />
                ) : (
                    <GraphRenderer2D
                        ref={rendererRef}
                        snapshot={preparedSnapshot}
                        graphMode={graphMode}
                        localDepth={localDepth}
                        qualityProfile={qualityProfile}
                        selection={selection}
                        canvasTheme={canvasTheme}
                        linkThickness={linkThickness}
                        arrows={arrows}
                        centerForce={centerForce}
                        repelForce={repelForce}
                        linkForce={linkForce}
                        linkDistance={linkDistance}
                        nodeSize={nodeSize}
                        glowIntensity={glowIntensity}
                        textFadeThreshold={textFadeThreshold}
                        layoutKey={layoutKey}
                        restoredFromCache={
                            preparedLayout?.restoredFromCache ?? false
                        }
                        shouldRunSimulation={shouldRunSimulation}
                        cooldownTicks={cooldownTicks}
                        callbacks={rendererCallbacks}
                    />
                )}
                {(graphStatusMessage ||
                    truncationMessage ||
                    suggestionActions.length > 0) && (
                    <div
                        style={{
                            position: "absolute",
                            top: 12,
                            left: 12,
                            padding: "10px 12px",
                            borderRadius: 10,
                            background: "rgba(0, 0, 0, 0.58)",
                            border: "1px solid rgba(255, 255, 255, 0.08)",
                            backdropFilter: "blur(12px)",
                            color: "var(--text-primary)",
                            pointerEvents: "auto",
                            maxWidth: 320,
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                        }}
                    >
                        {graphStatusMessage && (
                            <>
                                <div
                                    style={{
                                        fontSize: 12,
                                        fontWeight: 600,
                                        lineHeight: 1.35,
                                    }}
                                >
                                    {graphStatusMessage.title}
                                </div>
                                <div
                                    style={{
                                        fontSize: 11,
                                        color: "var(--text-secondary)",
                                        lineHeight: 1.35,
                                    }}
                                >
                                    {graphStatusMessage.detail}
                                </div>
                            </>
                        )}
                        {truncationMessage && (
                            <div
                                style={{
                                    fontSize: 11,
                                    color: "var(--text-secondary)",
                                    lineHeight: 1.35,
                                    paddingTop: 4,
                                    borderTop:
                                        "1px solid rgba(255, 255, 255, 0.08)",
                                }}
                            >
                                {truncationMessage.title}.{" "}
                                {truncationMessage.detail}. Current mode limit:{" "}
                                {GRAPH_NUMBER_FORMAT.format(currentLimit)}{" "}
                                nodes.
                            </div>
                        )}
                        {suggestionActions.length > 0 && (
                            <div
                                style={{
                                    display: "flex",
                                    gap: 6,
                                    flexWrap: "wrap",
                                }}
                            >
                                {suggestionActions.map((suggestion) => (
                                    <button
                                        key={suggestion.label}
                                        onClick={suggestion.action}
                                        style={{
                                            padding: "6px 8px",
                                            borderRadius: 8,
                                            border: "1px solid rgba(255, 255, 255, 0.1)",
                                            background:
                                                "rgba(255, 255, 255, 0.06)",
                                            color: "var(--text-primary)",
                                            fontSize: 11,
                                            cursor: "pointer",
                                        }}
                                    >
                                        {suggestion.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {toggleButton}
                {contextMenu && (
                    <GraphContextMenu
                        menu={contextMenu}
                        onClose={() => setContextMenu(null)}
                        onOpenNote={openNoteById}
                        onOpenInNewTab={handleOpenInNewTab}
                        onRevealInTree={handleRevealInTree}
                    />
                )}
            </div>
        </div>
    );
}
