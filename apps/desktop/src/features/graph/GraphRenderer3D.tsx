import ForceGraph3D, {
    type ForceGraphMethods,
    type NodeObject,
} from "react-force-graph-3d";
import * as THREE from "three";
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
import type {
    GraphPosition,
    GraphRenderNode,
    GraphRendererHandle,
} from "./graphRenderModel";

type GraphRendererNode = GraphRenderNode & {
    x?: number;
    y?: number;
    z?: number;
    fx?: number;
    fy?: number;
    fz?: number;
    vx?: number;
    vy?: number;
    vz?: number;
};

interface GraphRendererData {
    nodes: GraphRendererNode[];
    links: Array<{ source: string; target: string }>;
}

type GNode = NodeObject<GraphRendererNode>;

const COLORS = {
    node: "#6366f1",
    active: "#f59e0b",
    cluster: "#22d3ee",
    tag: "#10b981",
    attachment: "#f472b6",
} as const;

function toRendererData(
    snapshot: GraphRendererProps["snapshot"],
): GraphRendererData {
    return {
        nodes: snapshot.nodes.map((node) => ({
            ...node,
            x: node.position?.x,
            y: node.position?.y,
            z: node.position?.z,
        })),
        links: snapshot.links,
    };
}

function extractPositions(
    nodes: GraphRendererNode[],
): Record<string, GraphPosition> {
    const positions: Record<string, GraphPosition> = {};
    for (const node of nodes) {
        if (
            typeof node.x !== "number" ||
            typeof node.y !== "number" ||
            typeof node.z !== "number"
        ) {
            continue;
        }
        positions[node.id] = {
            x: node.x,
            y: node.y,
            z: node.z,
        };
    }
    return positions;
}

function colorForNode(
    node: GraphRendererNode,
    activeNodeId: string | null,
): string {
    if (node.id === activeNodeId || node.isRoot) return COLORS.active;
    switch (node.nodeType) {
        case "cluster":
            return COLORS.cluster;
        case "tag":
            return COLORS.tag;
        case "attachment":
            return COLORS.attachment;
        default:
            return node.groupColor ?? COLORS.node;
    }
}

function makeTextSprite(
    text: string,
    color: string,
    yOffset: number,
): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const fontSize = 48;
    const font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.font = font;
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const pad = 24;
    canvas.width = Math.min(textWidth + pad * 2, 512);
    canvas.height = fontSize + pad;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Dark outline for legibility
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.lineWidth = 5;
    ctx.lineJoin = "round";
    ctx.strokeText(
        text,
        canvas.width / 2,
        canvas.height / 2,
        canvas.width - pad,
    );
    // Foreground fill
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - pad);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const spriteMat = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    const spriteScale = canvas.width / canvas.height;
    sprite.scale.set(spriteScale * 3, 3, 1);
    sprite.position.set(0, yOffset, 0);
    return sprite;
}

function objectForNode(
    node: GraphRendererNode,
    color: string,
    scale: number,
    opacity: number,
): THREE.Object3D {
    const importance = node.importance ?? 1;
    const size =
        (node.nodeType === "cluster"
            ? 4 + Math.min(Math.sqrt(importance) * 0.9, 8)
            : 2.2 + Math.min(importance * 0.3, 4)) * scale;

    // Emissive scales with importance — hub nodes glow brighter
    const baseEmissive = node.isRoot
        ? 0.65
        : 0.15 + Math.min(importance * 0.04, 0.45);

    const material = new THREE.MeshStandardMaterial({
        color,
        emissive: new THREE.Color(color),
        emissiveIntensity: baseEmissive,
        roughness: 0.35,
        metalness: 0.15,
        transparent: opacity < 1,
        opacity,
    });

    let mesh: THREE.Mesh;
    switch (node.nodeType) {
        case "cluster":
        case "tag":
            mesh = new THREE.Mesh(
                new THREE.OctahedronGeometry(size, 1),
                material,
            );
            break;
        case "attachment":
            mesh = new THREE.Mesh(
                new THREE.BoxGeometry(size, size, size, 2, 2, 2),
                material,
            );
            break;
        default:
            mesh = new THREE.Mesh(
                new THREE.SphereGeometry(size, 28, 28),
                material,
            );
            break;
    }

    const label = node.title || node.id;
    const group = new THREE.Group();
    group.add(mesh);
    group.add(makeTextSprite(label, color, -(size + 2.5)));
    return group;
}

export const GraphRenderer3D = forwardRef<
    GraphRendererHandle,
    GraphRendererProps
>(function GraphRenderer3D(
    {
        snapshot,
        qualityProfile,
        selection,
        linkThickness,
        arrows,
        repelForce,
        linkForce,
        linkDistance,
        nodeSize,
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
    const renderDataRef = useRef<GraphRendererData | null>(null);
    const hasFitLayoutKeyRef = useRef<string | null>(null);
    const persistedLayoutKeyRef = useRef<string | null>(null);
    const lastSimulatedLayoutKeyRef = useRef<string | null>(null);
    const interactionSampleRef = useRef<{
        dragCancel?: () => void;
        zoomCancel?: () => void;
        hoverCancel?: () => void;
    }>({});
    const dataReadyAtRef = useRef<number | null>(null);

    const renderData = useMemo(() => toRendererData(snapshot), [snapshot]);

    useEffect(() => {
        renderDataRef.current = renderData;
    }, [renderData]);

    const nodeScale = nodeSize / 3;

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = renderDataRef.current?.nodes.find(
                (item) => item.id === nodeId,
            );
            if (
                !node ||
                typeof node.x !== "number" ||
                typeof node.y !== "number" ||
                typeof node.z !== "number"
            ) {
                return;
            }

            const distance = 120;
            const distRatio =
                1 +
                distance / Math.hypot(node.x || 1, node.y || 1, node.z || 1);

            fgRef.current?.cameraPosition(
                {
                    x: node.x * distRatio,
                    y: node.y * distRatio,
                    z: node.z * distRatio,
                },
                { x: node.x, y: node.y, z: node.z },
                500,
            );
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
            setSelection: (nodeId) => callbacks.onSelectionChange?.(nodeId),
            setQualityMode: (mode) => callbacks.onQualityModeChange?.(mode),
            highlightNeighbors: (nodeId) =>
                callbacks.onHighlightNeighbors?.(nodeId),
        }),
        [callbacks, focusNode],
    );

    const persistCurrentLayout = useCallback(() => {
        if (!persistedLayoutKeyRef.current) return;
        const currentGraph = renderDataRef.current;
        if (!currentGraph) return;
        callbacks.onPersistPositions?.(extractPositions(currentGraph.nodes));
    }, [callbacks]);

    const nodeOpacityFor = useCallback(
        (node: GNode) => {
            const hasFocusedNeighborhood =
                selection.highlightedNeighborIds.size > 0;
            if (!hasFocusedNeighborhood) return 0.95;
            if (
                selection.highlightedNeighborIds.has(node.id as string) ||
                selection.selectedNodeId === node.id
            ) {
                return 1;
            }
            return 0.28;
        },
        [selection.highlightedNeighborIds, selection.selectedNodeId],
    );

    const nodeColor = useCallback(
        (node: GNode) => {
            const opacity = nodeOpacityFor(node);
            if (opacity < 1) {
                return "rgba(120,120,140,0.35)";
            }
            return colorForNode(node, selection.activeNodeId);
        },
        [nodeOpacityFor, selection.activeNodeId],
    );

    const nodeThreeObject = useCallback(
        (node: GNode) => {
            const color = colorForNode(node, selection.activeNodeId);
            return objectForNode(node, color, nodeScale, nodeOpacityFor(node));
        },
        [nodeOpacityFor, nodeScale, selection.activeNodeId],
    );

    const linkColor = useCallback(
        (link: {
            source: string | GraphRendererNode;
            target: string | GraphRendererNode;
        }) => {
            const sourceId =
                typeof link.source === "object" ? link.source.id : link.source;
            const targetId =
                typeof link.target === "object" ? link.target.id : link.target;
            const hasFocusedNeighborhood =
                selection.highlightedNeighborIds.size > 0;
            if (!hasFocusedNeighborhood) {
                return "rgba(255,255,255,0.12)";
            }
            const highlighted =
                selection.highlightedNeighborIds.has(sourceId) &&
                selection.highlightedNeighborIds.has(targetId);
            return highlighted
                ? "rgba(255,255,255,0.34)"
                : "rgba(255,255,255,0.04)";
        },
        [selection.highlightedNeighborIds],
    );

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
        if (hasFitLayoutKeyRef.current === layoutKey) return;
        hasFitLayoutKeyRef.current = layoutKey;
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
        graphPerfCount("graph.view3d.data.ready", {
            nodeCount: renderData.nodes.length,
            linkCount: renderData.links.length,
            qualityMode: qualityProfile.mode,
            restoredLayout: restoredFromCache ? 1 : 0,
        });
        const rafId = window.requestAnimationFrame(() => {
            graphPerfMeasure(
                "graph.view3d.firstFrameAfterData.duration",
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
        const fg = fgRef.current;
        if (!fg) return;

        const charge = fg.d3Force("charge");
        if (charge && "strength" in charge) {
            (charge as unknown as { strength: (v: number) => void }).strength(
                -repelForce,
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
    }, [linkDistance, linkForce, repelForce, shouldRunSimulation]);

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
                    scheduleGraphFpsSample("graph.fps.3d.hover", {
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
                "graph.fps.3d.drag",
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
                "graph.fps.3d.zoom",
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
            <ForceGraph3D
                ref={fgRef}
                graphData={renderData}
                width={dimensions.width}
                height={dimensions.height}
                backgroundColor="#00000000"
                nodeLabel={(node) => node.title || (node.id as string)}
                nodeColor={nodeColor}
                nodeRelSize={4}
                nodeResolution={qualityProfile.mode === "cinematic" ? 12 : 8}
                nodeThreeObject={nodeThreeObject}
                linkColor={linkColor}
                linkWidth={Math.max(0.2, linkThickness * 0.9)}
                linkDirectionalArrowLength={arrows ? 3 : 0}
                linkDirectionalArrowRelPos={1}
                linkDirectionalParticles={qualityProfile.particleCount}
                linkDirectionalParticleSpeed={qualityProfile.particleSpeed}
                linkDirectionalParticleWidth={qualityProfile.particleWidth}
                enablePointerInteraction={
                    qualityProfile.enablePointerInteraction
                }
                enableNodeDrag={qualityProfile.enableNodeDrag}
                cooldownTicks={cooldownTicks}
                onNodeClick={handleNodeClick}
                onNodeRightClick={handleNodeRightClick}
                onNodeHover={
                    qualityProfile.enableHover ? handleNodeHover : undefined
                }
                onBackgroundClick={handleBackgroundClick}
                onNodeDragEnd={persistCurrentLayout}
                onEngineStop={persistCurrentLayout}
            />
        </div>
    );
});
