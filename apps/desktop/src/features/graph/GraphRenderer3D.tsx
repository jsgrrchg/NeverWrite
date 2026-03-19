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
import { getFocusedCameraPosition, getGraphFocusDistance } from "./graphCamera";
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
type NodeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
type NodeLabel = THREE.Sprite;
type NodeVisualState = {
    color: string;
    opacity: number;
    showLabel: boolean;
    labelColor: string;
    emissiveIntensity: number;
};
type CachedNodeVisualRefs = {
    mesh: NodeMesh;
    label: NodeLabel;
};
type CachedNodeObject = {
    signature: string;
    object: THREE.Object3D;
    refs: CachedNodeVisualRefs;
    visualSignature: string | null;
};
type GraphRendererVisualProps = {
    selection: GraphRendererProps["selection"];
    qualityProfile: GraphRendererProps["qualityProfile"];
    showTitles: boolean;
    textFadeThreshold: number;
    glowIntensity: number;
    labelRgb: [number, number, number];
    activeNodeId: string | null;
};

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

function makeTextSprite(text: string, yOffset: number): NodeLabel {
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
    ctx.fillStyle = "#ffffff";
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
    backlinkCount: number,
    scale: number,
): { object: THREE.Object3D; refs: CachedNodeVisualRefs } {
    const importance = node.importance ?? 1;
    const size =
        (node.nodeType === "cluster"
            ? 4 + Math.min(Math.sqrt(importance) * 0.9, 8)
            : 2.2 + Math.min(backlinkCount * 0.55, 4.5)) * scale;

    const material = new THREE.MeshStandardMaterial({
        color: "#ffffff",
        emissive: new THREE.Color("#ffffff"),
        emissiveIntensity: 0.3,
        roughness: 0.35,
        metalness: 0.15,
        transparent: true,
        opacity: 1,
    });

    let mesh: NodeMesh;
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
    const labelSprite = makeTextSprite(label, -(size + 2.5));
    group.add(labelSprite);
    return {
        object: group,
        refs: {
            mesh,
            label: labelSprite,
        },
    };
}

function rgbToHex([r, g, b]: [number, number, number]): string {
    return new THREE.Color(`rgb(${r}, ${g}, ${b})`).getHexString();
}

function labelColorForNode(
    node: GraphRendererNode,
    activeNodeId: string | null,
    labelRgb: [number, number, number],
): string {
    if (
        node.id === activeNodeId ||
        node.isRoot ||
        node.nodeType === "cluster" ||
        node.nodeType === "tag" ||
        node.nodeType === "attachment" ||
        node.groupColor
    ) {
        return colorForNode(node, activeNodeId);
    }

    return `#${rgbToHex(labelRgb)}`;
}

function shouldShowNodeLabel(showTitles: boolean): boolean {
    return showTitles;
}

function buildNodeVisualState(
    node: GraphRendererNode,
    selection: GraphRendererProps["selection"],
    showTitles: boolean,
    glowIntensity: number,
    labelRgb: [number, number, number],
): NodeVisualState {
    const color = colorForNode(node, selection.activeNodeId);
    const hasFocusedNeighborhood = selection.highlightedNeighborIds.size > 0;
    const opacity = hasFocusedNeighborhood
        ? selection.highlightedNeighborIds.has(node.id) ||
          selection.selectedNodeId === node.id
            ? 1
            : 0.28
        : 0.95;
    const baseEmissive = node.isRoot
        ? 0.65
        : 0.15 + Math.min((node.importance ?? 1) * 0.04, 0.45);

    return {
        color,
        opacity,
        showLabel: shouldShowNodeLabel(showTitles),
        labelColor: labelColorForNode(node, selection.activeNodeId, labelRgb),
        emissiveIntensity: baseEmissive * (glowIntensity / 50),
    };
}

function updateNodeVisualState(
    cached: CachedNodeObject,
    visualState: NodeVisualState,
) {
    const visualSignature = [
        visualState.color,
        visualState.opacity,
        visualState.showLabel ? "1" : "0",
        visualState.labelColor,
        visualState.emissiveIntensity,
    ].join("\u0000");
    if (cached.visualSignature === visualSignature) {
        return;
    }

    cached.visualSignature = visualSignature;

    const { mesh, label } = cached.refs;
    const labelMaterial = label.material as THREE.SpriteMaterial;
    mesh.material.color.set(visualState.color);
    mesh.material.emissive.set(visualState.color);
    mesh.material.emissiveIntensity = visualState.emissiveIntensity;
    mesh.material.opacity = visualState.opacity;
    mesh.material.transparent = visualState.opacity < 1;
    mesh.material.needsUpdate = true;

    label.visible = visualState.showLabel;
    labelMaterial.color.set(visualState.labelColor);
    labelMaterial.opacity = visualState.opacity;
    labelMaterial.needsUpdate = true;
}

function disposeMaterial(material: THREE.Material) {
    for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) {
            value.dispose();
        }
    }
    material.dispose();
}

function disposeThreeObject(object: THREE.Object3D) {
    object.traverse((child) => {
        const geometry = (
            child as THREE.Object3D & { geometry?: THREE.BufferGeometry }
        ).geometry;
        if (geometry) {
            geometry.dispose();
        }

        const material = (
            child as THREE.Object3D & {
                material?: THREE.Material | THREE.Material[];
            }
        ).material;

        if (Array.isArray(material)) {
            material.forEach(disposeMaterial);
        } else if (material) {
            disposeMaterial(material);
        }
    });
}

export const GraphRenderer3D = forwardRef<
    GraphRendererHandle,
    GraphRendererProps
>(function GraphRenderer3D(
    {
        snapshot,
        isVisible,
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
        showTitles,
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
    const renderDataRef = useRef<GraphRendererData | null>(null);
    const nodeObjectCacheRef = useRef<Map<string, CachedNodeObject>>(new Map());
    const lastFitSignatureRef = useRef<string | null>(null);
    const persistedLayoutKeyRef = useRef<string | null>(null);
    const lastSimulatedLayoutKeyRef = useRef<string | null>(null);
    const visualPropsRef = useRef<GraphRendererVisualProps>({
        selection,
        qualityProfile,
        showTitles,
        textFadeThreshold,
        glowIntensity,
        labelRgb: canvasTheme.labelRgb,
        activeNodeId: selection.activeNodeId,
    });
    const interactionSampleRef = useRef<{
        dragCancel?: () => void;
        zoomCancel?: () => void;
        hoverCancel?: () => void;
    }>({});
    const dataReadyAtRef = useRef<number | null>(null);
    const effectiveShouldRunSimulation = shouldRunSimulation && isVisible;

    const renderData = useMemo(() => toRendererData(snapshot), [snapshot]);

    useEffect(() => {
        renderDataRef.current = renderData;
    }, [renderData]);

    const nodeScale = nodeSize / 3;
    const labelRgb = canvasTheme.labelRgb;
    const backlinkCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const link of renderData.links) {
            counts.set(link.target, (counts.get(link.target) ?? 0) + 1);
        }
        return counts;
    }, [renderData.links]);

    useEffect(() => {
        visualPropsRef.current = {
            selection,
            qualityProfile,
            showTitles,
            textFadeThreshold,
            glowIntensity,
            labelRgb,
            activeNodeId: selection.activeNodeId,
        };
    }, [
        glowIntensity,
        labelRgb,
        qualityProfile,
        selection,
        showTitles,
        textFadeThreshold,
    ]);

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

            const camera = fgRef.current?.camera();
            const currentDistance = camera
                ? Math.hypot(
                      camera.position.x - node.x,
                      camera.position.y - node.y,
                      camera.position.z - node.z,
                  )
                : null;
            const distance = getGraphFocusDistance(
                currentDistance,
                node.importance ?? 1,
            );
            const position = getFocusedCameraPosition(
                { x: node.x, y: node.y, z: node.z },
                camera
                    ? {
                          x: camera.position.x,
                          y: camera.position.y,
                          z: camera.position.z,
                      }
                    : null,
                distance,
            );

            fgRef.current?.cameraPosition(
                position,
                { x: node.x, y: node.y, z: node.z },
                1100,
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

    const nodeColor = useCallback((node: GNode) => {
        const visualProps = visualPropsRef.current;
        const visualState = buildNodeVisualState(
            node,
            visualProps.selection,
            visualProps.showTitles,
            visualProps.glowIntensity,
            visualProps.labelRgb,
        );
        if (visualState.opacity < 1) {
            return "rgba(120,120,140,0.35)";
        }
        return visualState.color;
    }, []);

    const nodeThreeObject = useCallback(
        (node: GNode) => {
            const nodeId = node.id as string;
            const backlinkCount = backlinkCounts.get(nodeId) ?? 0;
            const signature = [
                node.title ?? "",
                node.nodeType ?? "",
                node.importance ?? 1,
                backlinkCount,
                nodeScale,
            ].join("\u0000");
            const cached = nodeObjectCacheRef.current.get(nodeId);
            const visualProps = visualPropsRef.current;
            const visualState = buildNodeVisualState(
                node,
                visualProps.selection,
                visualProps.showTitles,
                visualProps.glowIntensity,
                visualProps.labelRgb,
            );

            if (cached?.signature === signature) {
                updateNodeVisualState(cached, visualState);
                return cached.object;
            }

            if (cached) {
                disposeThreeObject(cached.object);
            }

            const created = objectForNode(node, backlinkCount, nodeScale);
            const nextCached: CachedNodeObject = {
                signature,
                object: created.object,
                refs: created.refs,
                visualSignature: null,
            };
            updateNodeVisualState(nextCached, visualState);
            nodeObjectCacheRef.current.set(nodeId, nextCached);
            return created.object;
        },
        [backlinkCounts, nodeScale],
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
        if (!isVisible) return;
        if (dimensions.width < 10 || dimensions.height < 10) return;
        const nextSignature = `${layoutKey}:${dimensions.width}x${dimensions.height}`;
        if (lastFitSignatureRef.current === nextSignature) return;
        lastFitSignatureRef.current = nextSignature;
        const timeoutId = window.setTimeout(
            () => fgRef.current?.zoomToFit(400, 60),
            180,
        );
        return () => window.clearTimeout(timeoutId);
    }, [dimensions.height, dimensions.width, isVisible, layoutKey]);

    useEffect(() => {
        const activeNodeIds = new Set(renderData.nodes.map((node) => node.id));
        const cache = nodeObjectCacheRef.current;

        for (const [nodeId, cached] of cache) {
            if (activeNodeIds.has(nodeId)) continue;
            disposeThreeObject(cached.object);
            cache.delete(nodeId);
        }
    }, [renderData.nodes]);

    useEffect(() => {
        const cache = nodeObjectCacheRef.current;
        for (const node of renderData.nodes) {
            const cached = cache.get(node.id);
            if (!cached) continue;
            updateNodeVisualState(
                cached,
                buildNodeVisualState(
                    node,
                    selection,
                    showTitles,
                    glowIntensity,
                    labelRgb,
                ),
            );
        }
    }, [
        glowIntensity,
        labelRgb,
        qualityProfile,
        renderData.nodes,
        selection,
        showTitles,
        textFadeThreshold,
    ]);

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
        if (!isVisible) return;
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
        isVisible,
        qualityProfile.mode,
        renderData.links.length,
        renderData.nodes.length,
        restoredFromCache,
    ]);

    useEffect(() => {
        if (isVisible && qualityProfile.enableHover) return;
        interactionSampleRef.current.hoverCancel?.();
        interactionSampleRef.current.hoverCancel = undefined;
        callbacks.onNodeHover?.(null);
    }, [callbacks, isVisible, qualityProfile.enableHover]);

    useEffect(() => {
        const fg = fgRef.current as
            | (ForceGraphMethods<GNode> & {
                  pauseAnimation?: () => void;
                  resumeAnimation?: () => void;
              })
            | undefined;
        if (!fg) return;
        if (isVisible) {
            fg.resumeAnimation?.();
            return;
        }
        fg.pauseAnimation?.();
    }, [isVisible]);

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

        if (effectiveShouldRunSimulation) {
            fg.d3ReheatSimulation();
        }
    }, [
        centerForce,
        effectiveShouldRunSimulation,
        linkDistance,
        linkForce,
        repelForce,
    ]);

    useEffect(() => {
        if (!shouldRunSimulation) {
            lastSimulatedLayoutKeyRef.current = layoutKey;
            return;
        }
        if (!isVisible) return;
        if (lastSimulatedLayoutKeyRef.current === layoutKey) return;
        lastSimulatedLayoutKeyRef.current = layoutKey;
        fgRef.current?.d3ReheatSimulation();
    }, [isVisible, layoutKey, shouldRunSimulation]);

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
        const nodeObjectCache = nodeObjectCacheRef.current;
        return () => {
            samples.dragCancel?.();
            samples.zoomCancel?.();
            samples.hoverCancel?.();
            persistCurrentLayout();

            for (const cached of nodeObjectCache.values()) {
                disposeThreeObject(cached.object);
            }
            nodeObjectCache.clear();
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
                    isVisible && qualityProfile.enablePointerInteraction
                }
                enableNodeDrag={isVisible && qualityProfile.enableNodeDrag}
                cooldownTicks={cooldownTicks}
                onNodeClick={handleNodeClick}
                onNodeRightClick={handleNodeRightClick}
                onNodeHover={
                    isVisible && qualityProfile.enableHover
                        ? handleNodeHover
                        : undefined
                }
                onBackgroundClick={handleBackgroundClick}
                onNodeDragEnd={persistCurrentLayout}
                onEngineStop={persistCurrentLayout}
            />
        </div>
    );
});
