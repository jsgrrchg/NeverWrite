import ForceGraph2D, {
    type ForceGraphMethods,
    type NodeObject,
} from "react-force-graph-2d";
import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    graphPerfCount,
    graphPerfMeasure,
    scheduleGraphFpsSample,
} from "./graphPerf";
import type { GraphRendererProps } from "./graphRendererProps";
import type { GraphMode, GraphQualityMode } from "./graphSettingsStore";
import type {
    GraphPosition,
    GraphRenderNode,
    GraphRenderSnapshot,
    GraphRendererHandle,
    GraphRendererSelectionState,
} from "./graphRenderModel";

type GraphRendererNode = GraphRenderNode & {
    x?: number;
    y?: number;
    fx?: number;
    fy?: number;
    vx?: number;
    vy?: number;
};

interface GraphRendererData extends Omit<GraphRenderSnapshot, "nodes"> {
    nodes: GraphRendererNode[];
}

type GNode = NodeObject<GraphRendererNode>;

interface PaintState {
    selection: GraphRendererSelectionState;
    backlinkCounts: Map<string, number>;
    sizeMul: number;
    glowMul: number;
    textFadeThreshold: number;
    graphMode: GraphMode;
    localDepth: number;
    labelRgb: [number, number, number];
    qualityMode: GraphQualityMode;
    showLabelsOnZoom: boolean;
    showLabelsOnHover: boolean;
    showNodeGlow: boolean;
    simplifiedGlow: boolean;
    overviewShapes: boolean;
    pointerPadding: number;
}

const COLORS = {
    node: "#6366f1",
    nodeGlow: "rgba(99, 102, 241, 0.4)",
    active: "#f59e0b",
    activeGlow: "rgba(245, 158, 11, 0.6)",
    cluster: "#22d3ee",
    clusterGlow: "rgba(34, 211, 238, 0.45)",
    tag: "#10b981",
    tagGlow: "rgba(16, 185, 129, 0.4)",
    attachment: "#f472b6",
    attachmentGlow: "rgba(244, 114, 182, 0.4)",
} as const;

const NODE_MODE = () => "replace" as const;
const NODE_LABEL = (node: GNode) => node.title || (node.id as string);

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function toRendererData(snapshot: GraphRenderSnapshot): GraphRendererData {
    return {
        ...snapshot,
        nodes: snapshot.nodes.map((node) => ({
            ...node,
            x: node.position?.x,
            y: node.position?.y,
        })),
    };
}

function extractPositions(
    nodes: GraphRendererNode[],
): Record<string, GraphPosition> {
    const positions: Record<string, GraphPosition> = {};
    for (const node of nodes) {
        if (typeof node.x !== "number" || typeof node.y !== "number") continue;
        positions[node.id] = {
            x: node.x,
            y: node.y,
            z: node.position?.z,
        };
    }
    return positions;
}

export const GraphRenderer2D = forwardRef<
    GraphRendererHandle,
    GraphRendererProps
>(function GraphRenderer2D(
    {
        snapshot,
        graphMode,
        localDepth,
        qualityProfile,
        selection,
        canvasTheme,
        linkThickness,
        arrows,
        centerForce,
        repelForce,
        linkForce,
        linkDistance,
        nodeSize,
        glowIntensity,
        textFadeThreshold,
        layoutKey,
        restoredFromCache,
        shouldRunSimulation,
        cooldownTicks,
        callbacks,
    },
    ref,
) {
    const containerRef = useRef<HTMLDivElement>(null);
    const fgRef = useRef<ForceGraphMethods<GNode> | undefined>(undefined);
    const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
    const dataReadyAtRef = useRef<number | null>(null);
    const interactionSampleRef = useRef<{
        dragCancel?: () => void;
        zoomCancel?: () => void;
        hoverCancel?: () => void;
    }>({});
    const renderDataRef = useRef<GraphRendererData | null>(null);
    const persistedLayoutKeyRef = useRef<string | null>(null);
    const hasZoomedLayoutKeyRef = useRef<string | null>(null);
    const lastSimulatedLayoutKeyRef = useRef<string | null>(null);

    const renderData = useMemo(() => toRendererData(snapshot), [snapshot]);

    const arrowLen = arrows ? 4 : 0;
    const glowMul = glowIntensity / 50;
    const sizeMul = nodeSize / 3;

    const backlinkCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const link of renderData.links) {
            counts.set(link.target, (counts.get(link.target) ?? 0) + 1);
        }
        return counts;
    }, [renderData.links]);

    const paintStateRef = useRef<PaintState>({
        selection,
        backlinkCounts,
        sizeMul,
        glowMul,
        textFadeThreshold,
        graphMode,
        localDepth,
        labelRgb: canvasTheme.labelRgb,
        qualityMode: qualityProfile.mode,
        showLabelsOnZoom: qualityProfile.showLabelsOnZoom,
        showLabelsOnHover: qualityProfile.showLabelsOnHover,
        showNodeGlow: qualityProfile.showNodeGlow,
        simplifiedGlow: qualityProfile.simplifiedGlow,
        overviewShapes: qualityProfile.overviewShapes,
        pointerPadding: qualityProfile.pointerPadding,
    });

    const linkColorFn = useCallback(
        () => canvasTheme.linkColor,
        [canvasTheme.linkColor],
    );
    const particleColorFn = useCallback(
        () => canvasTheme.particleColor,
        [canvasTheme.particleColor],
    );

    const persistCurrentLayout = useCallback(() => {
        if (!persistedLayoutKeyRef.current) return;
        const currentGraph = renderDataRef.current;
        if (!currentGraph) return;
        callbacks.onPersistPositions?.(extractPositions(currentGraph.nodes));
    }, [callbacks]);

    const paintNode = useCallback(
        (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const ps = paintStateRef.current;
            const x = node.x ?? 0;
            const y = node.y ?? 0;
            const label = node.title || (node.id as string);
            const noteId = node.id as string;

            const blCount = ps.backlinkCounts.get(noteId) ?? 0;
            const isCluster = node.nodeType === "cluster";
            const baseR =
                (isCluster
                    ? 8 + Math.min(Math.sqrt(node.importance ?? 1) * 1.8, 18)
                    : 2.5 + Math.min(blCount * 0.7, 5.5)) *
                ps.sizeMul *
                (ps.qualityMode === "overview" ? 0.9 : 1);
            const isHovered = ps.selection.hoveredNodeId === noteId;
            const isActive = ps.selection.activeNodeId === noteId;
            const isSelected = ps.selection.selectedNodeId === noteId;
            const hasHighlight =
                ps.selection.highlightedNeighborIds.size > 0 &&
                ps.selection.highlightedNeighborIds.has(noteId);
            const hasFocusedNeighborhood =
                ps.selection.highlightedNeighborIds.size > 0;
            const nodeR = isHovered || isSelected ? baseR * 1.4 : baseR;

            const hopDist = node.hopDistance;
            const isLocalMode = ps.graphMode === "local" && hopDist != null;
            const distanceFade = isLocalMode
                ? 1.0 - (hopDist / Math.max(ps.localDepth, 1)) * 0.5
                : 1.0;

            const isRoot =
                node.isRoot === true || (isLocalMode && hopDist === 0);
            const isTag = node.nodeType === "tag";
            const isAttachment = node.nodeType === "attachment";
            const groupColor = node.groupColor;

            let nodeColor: string;
            let glowColor: string;
            if (isActive || isRoot) {
                nodeColor = COLORS.active;
                glowColor = COLORS.activeGlow;
            } else if (isCluster) {
                nodeColor = COLORS.cluster;
                glowColor = COLORS.clusterGlow;
            } else if (isTag) {
                nodeColor = COLORS.tag;
                glowColor = COLORS.tagGlow;
            } else if (isAttachment) {
                nodeColor = COLORS.attachment;
                glowColor = COLORS.attachmentGlow;
            } else if (groupColor) {
                nodeColor = groupColor;
                glowColor = hexToRgba(groupColor, 0.4);
            } else {
                nodeColor = COLORS.node;
                glowColor = COLORS.nodeGlow;
            }

            ctx.save();
            if (hasFocusedNeighborhood && !hasHighlight && !isSelected) {
                ctx.globalAlpha *= 0.3;
            }
            if (isLocalMode && !isRoot && !isHovered) {
                ctx.globalAlpha *= distanceFade;
            }

            if (ps.showNodeGlow && ps.glowMul > 0) {
                const haloR =
                    nodeR *
                    (isHovered || isSelected
                        ? 3.2
                        : ps.simplifiedGlow
                          ? 2.1
                          : 3);
                const haloAlpha = ps.simplifiedGlow
                    ? (isActive || isRoot || isSelected
                          ? 0.09
                          : 0.05 * distanceFade) * ps.glowMul
                    : (isActive || isRoot || isSelected
                          ? 0.14
                          : 0.1 * distanceFade) * ps.glowMul;

                if (!ps.simplifiedGlow) {
                    const gradient = ctx.createRadialGradient(
                        x,
                        y,
                        nodeR * 0.3,
                        x,
                        y,
                        haloR,
                    );
                    gradient.addColorStop(0, hexToRgba(nodeColor, haloAlpha));
                    gradient.addColorStop(1, hexToRgba(nodeColor, 0));
                    ctx.fillStyle = gradient;
                    ctx.beginPath();
                    ctx.arc(x, y, haloR, 0, 2 * Math.PI);
                    ctx.fill();
                }

                ctx.shadowBlur =
                    (ps.simplifiedGlow
                        ? isActive || isRoot || isSelected
                            ? 6
                            : 3
                        : isHovered || isSelected
                          ? 20
                          : isActive || isRoot
                            ? 14
                            : 8 * distanceFade) * ps.glowMul;
                ctx.shadowColor = glowColor;
            }

            ctx.beginPath();
            if (isTag || isCluster || (ps.overviewShapes && !isAttachment)) {
                const d = nodeR * 1.3;
                ctx.moveTo(x, y - d);
                ctx.lineTo(x + d, y);
                ctx.lineTo(x, y + d);
                ctx.lineTo(x - d, y);
                ctx.closePath();
            } else if (isAttachment) {
                const s = nodeR * 0.7;
                const r = s * 0.3;
                ctx.roundRect(x - s, y - s, s * 2, s * 2, r);
            } else {
                ctx.arc(x, y, nodeR, 0, 2 * Math.PI);
            }
            ctx.fillStyle = nodeColor;
            ctx.fill();
            ctx.restore();

            const showLabel =
                (ps.showLabelsOnZoom &&
                    globalScale > ps.textFadeThreshold &&
                    ps.qualityMode === "cinematic") ||
                (ps.showLabelsOnHover && isHovered) ||
                isCluster ||
                isActive ||
                isRoot ||
                isSelected;
            if (!showLabel) return;

            const fontSize = Math.min(12 / globalScale, 5);
            const alpha =
                isHovered || isActive || isRoot || isSelected
                    ? 1
                    : 0.75 * distanceFade;
            const hasCustomColor =
                isCluster ||
                isTag ||
                isAttachment ||
                isActive ||
                isRoot ||
                isSelected ||
                groupColor;
            const [lr, lg, lb] = ps.labelRgb;

            ctx.font = `${fontSize}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = hasCustomColor
                ? hexToRgba(nodeColor, alpha)
                : `rgba(${lr}, ${lg}, ${lb}, ${alpha})`;
            ctx.fillText(label, x, y + nodeR + 2);
        },
        [],
    );

    const paintNodePointerArea = useCallback(
        (node: GNode, color: string, ctx: CanvasRenderingContext2D) => {
            const ps = paintStateRef.current;
            const blCount = ps.backlinkCounts.get(node.id as string) ?? 0;
            const x = node.x ?? 0;
            const y = node.y ?? 0;
            const r = Math.max(
                5,
                (2.5 + Math.min(blCount * 0.7, 5.5)) * ps.sizeMul +
                    ps.pointerPadding,
            );
            ctx.beginPath();
            ctx.arc(x, y, r, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
        },
        [],
    );

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = renderDataRef.current?.nodes.find(
                (item) => item.id === nodeId,
            );
            if (
                !node ||
                typeof node.x !== "number" ||
                typeof node.y !== "number"
            ) {
                return;
            }
            fgRef.current?.centerAt(node.x, node.y, 400);
            fgRef.current?.zoom(4, 400);
            callbacks.onSelectionChange?.(nodeId);
            callbacks.onHighlightNeighbors?.(nodeId);
        },
        [callbacks],
    );

    useImperativeHandle(
        ref,
        () => ({
            focusNode,
            fitGraph: (durationMs = 400, paddingPx = 60) => {
                fgRef.current?.zoomToFit(durationMs, paddingPx);
            },
            setSelection: (nodeId) => {
                callbacks.onSelectionChange?.(nodeId);
            },
            setQualityMode: (mode) => {
                callbacks.onQualityModeChange?.(mode);
            },
            highlightNeighbors: (nodeId) => {
                callbacks.onHighlightNeighbors?.(nodeId);
            },
        }),
        [callbacks, focusNode],
    );

    useEffect(() => {
        renderDataRef.current = renderData;
    }, [renderData]);

    useEffect(() => {
        paintStateRef.current = {
            selection,
            backlinkCounts,
            sizeMul,
            glowMul,
            textFadeThreshold,
            graphMode,
            localDepth,
            labelRgb: canvasTheme.labelRgb,
            qualityMode: qualityProfile.mode,
            showLabelsOnZoom: qualityProfile.showLabelsOnZoom,
            showLabelsOnHover: qualityProfile.showLabelsOnHover,
            showNodeGlow: qualityProfile.showNodeGlow,
            simplifiedGlow: qualityProfile.simplifiedGlow,
            overviewShapes: qualityProfile.overviewShapes,
            pointerPadding: qualityProfile.pointerPadding,
        };
    }, [
        backlinkCounts,
        canvasTheme.labelRgb,
        glowMul,
        graphMode,
        localDepth,
        qualityProfile.mode,
        qualityProfile.overviewShapes,
        qualityProfile.pointerPadding,
        qualityProfile.showLabelsOnHover,
        qualityProfile.showLabelsOnZoom,
        qualityProfile.showNodeGlow,
        qualityProfile.simplifiedGlow,
        selection,
        sizeMul,
        textFadeThreshold,
    ]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            const { width, height } = entries[0].contentRect;
            setDimensions({ width, height });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        persistedLayoutKeyRef.current = layoutKey;
        if (restoredFromCache) return;
        if (hasZoomedLayoutKeyRef.current === layoutKey) return;
        hasZoomedLayoutKeyRef.current = layoutKey;
        window.setTimeout(() => fgRef.current?.zoomToFit(400, 60), 180);
    }, [layoutKey, restoredFromCache]);

    useEffect(() => {
        if (shouldRunSimulation) return;
        persistedLayoutKeyRef.current = layoutKey;
        if (restoredFromCache) return;
        callbacks.onPersistPositions?.(extractPositions(renderData.nodes));
    }, [
        callbacks,
        layoutKey,
        renderData.nodes,
        restoredFromCache,
        shouldRunSimulation,
    ]);

    useEffect(() => {
        dataReadyAtRef.current = performance.now();
        graphPerfCount("graph.view.data.ready", {
            nodeCount: renderData.nodes.length,
            linkCount: renderData.links.length,
            qualityMode: qualityProfile.mode,
            restoredLayout: restoredFromCache ? 1 : 0,
        });

        const rafId = window.requestAnimationFrame(() => {
            graphPerfMeasure(
                "graph.view.firstFrameAfterData.duration",
                dataReadyAtRef.current,
                {
                    nodeCount: renderData.nodes.length,
                    linkCount: renderData.links.length,
                    qualityMode: qualityProfile.mode,
                    restoredLayout: restoredFromCache ? 1 : 0,
                },
            );
        });

        return () => window.cancelAnimationFrame(rafId);
    }, [
        qualityProfile.mode,
        renderData.links.length,
        renderData.nodes.length,
        restoredFromCache,
    ]);

    useEffect(() => {
        if (qualityProfile.enableHover) return;
        interactionSampleRef.current.hoverCancel?.();
        interactionSampleRef.current.hoverCancel = undefined;
        callbacks.onNodeHover?.(null);
    }, [callbacks, qualityProfile.enableHover]);

    useEffect(() => {
        const fg = fgRef.current;
        if (!fg) return;

        const charge = fg.d3Force("charge");
        if (charge && "strength" in charge) {
            (charge as unknown as { strength: (v: number) => void }).strength(
                -repelForce,
            );
        }

        const center = fg.d3Force("center");
        if (center && "strength" in center) {
            (center as unknown as { strength: (v: number) => void }).strength(
                centerForce,
            );
        }

        const link = fg.d3Force("link");
        if (link) {
            if ("strength" in link) {
                (link as unknown as { strength: (v: number) => void }).strength(
                    linkForce,
                );
            }
            if ("distance" in link) {
                (link as unknown as { distance: (v: number) => void }).distance(
                    linkDistance,
                );
            }
        }

        if (shouldRunSimulation) {
            fg.d3ReheatSimulation();
        }
    }, [centerForce, linkDistance, linkForce, repelForce, shouldRunSimulation]);

    useEffect(() => {
        if (!shouldRunSimulation) {
            lastSimulatedLayoutKeyRef.current = layoutKey;
            return;
        }
        if (lastSimulatedLayoutKeyRef.current === layoutKey) return;
        lastSimulatedLayoutKeyRef.current = layoutKey;
        fgRef.current?.d3ReheatSimulation();
    }, [layoutKey, shouldRunSimulation]);

    const handleNodeClick = useCallback(
        (node: GNode) => {
            callbacks.onSelectionChange?.(node.id as string);
            callbacks.onHighlightNeighbors?.(node.id as string);
            callbacks.onNodeClick?.(node);
        },
        [callbacks],
    );

    const handleNodeRightClick = useCallback(
        (node: GNode, event: MouseEvent) => {
            event.preventDefault();
            callbacks.onSelectionChange?.(node.id as string);
            callbacks.onHighlightNeighbors?.(node.id as string);
            callbacks.onNodeContextMenu?.(node, event);
        },
        [callbacks],
    );

    const handleNodeHover = useCallback(
        (node: GNode | null) => {
            if (node) {
                interactionSampleRef.current.hoverCancel?.();
                interactionSampleRef.current.hoverCancel =
                    scheduleGraphFpsSample("graph.fps.hover", {
                        nodeCount: renderData.nodes.length,
                        linkCount: renderData.links.length,
                        qualityMode: qualityProfile.mode,
                    });
            }
            callbacks.onNodeHover?.(node ? (node.id as string) : null);
        },
        [
            callbacks,
            qualityProfile.mode,
            renderData.links.length,
            renderData.nodes.length,
        ],
    );

    const handleBackgroundClick = useCallback(() => {
        callbacks.onSelectionChange?.(null);
        callbacks.onHighlightNeighbors?.(null);
        callbacks.onBackgroundClick?.();
    }, [callbacks]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const handlePointerDown = () => {
            interactionSampleRef.current.dragCancel?.();
            interactionSampleRef.current.dragCancel = scheduleGraphFpsSample(
                "graph.fps.drag",
                {
                    nodeCount: renderData.nodes.length,
                    linkCount: renderData.links.length,
                    qualityMode: qualityProfile.mode,
                },
            );
        };

        const handleWheel = () => {
            interactionSampleRef.current.zoomCancel?.();
            interactionSampleRef.current.zoomCancel = scheduleGraphFpsSample(
                "graph.fps.zoom",
                {
                    nodeCount: renderData.nodes.length,
                    linkCount: renderData.links.length,
                    qualityMode: qualityProfile.mode,
                },
            );
        };

        el.addEventListener("pointerdown", handlePointerDown);
        el.addEventListener("wheel", handleWheel, { passive: true });
        return () => {
            el.removeEventListener("pointerdown", handlePointerDown);
            el.removeEventListener("wheel", handleWheel);
        };
    }, [qualityProfile.mode, renderData.links.length, renderData.nodes.length]);

    useEffect(() => {
        const samples = interactionSampleRef.current;
        return () => {
            samples.dragCancel?.();
            samples.zoomCancel?.();
            samples.hoverCancel?.();
            persistCurrentLayout();
        };
    }, [persistCurrentLayout]);

    return (
        <div
            ref={containerRef}
            style={{
                position: "absolute",
                inset: 0,
                background:
                    "radial-gradient(ellipse at center, var(--bg-secondary) 0%, var(--bg-primary) 70%)",
            }}
        >
            <ForceGraph2D
                ref={fgRef}
                graphData={renderData}
                width={dimensions.width}
                height={dimensions.height}
                backgroundColor="rgba(0,0,0,0)"
                autoPauseRedraw
                nodeCanvasObject={paintNode}
                nodeCanvasObjectMode={NODE_MODE}
                nodePointerAreaPaint={
                    qualityProfile.customPointerArea
                        ? paintNodePointerArea
                        : undefined
                }
                nodeLabel={NODE_LABEL}
                linkColor={linkColorFn}
                linkWidth={Math.max(
                    0.4,
                    linkThickness * qualityProfile.linkWidthMul,
                )}
                linkDirectionalArrowLength={
                    qualityProfile.mode === "overview" ? 0 : arrowLen
                }
                linkDirectionalArrowRelPos={1}
                linkDirectionalParticles={qualityProfile.particleCount}
                linkDirectionalParticleSpeed={qualityProfile.particleSpeed}
                linkDirectionalParticleWidth={qualityProfile.particleWidth}
                linkDirectionalParticleColor={particleColorFn}
                enablePointerInteraction={
                    qualityProfile.enablePointerInteraction
                }
                onNodeClick={handleNodeClick}
                onNodeRightClick={handleNodeRightClick}
                onNodeHover={
                    qualityProfile.enableHover ? handleNodeHover : undefined
                }
                onBackgroundClick={handleBackgroundClick}
                cooldownTicks={cooldownTicks}
                enableNodeDrag={qualityProfile.enableNodeDrag}
                onNodeDragEnd={persistCurrentLayout}
                onEngineStop={persistCurrentLayout}
            />
        </div>
    );
});
