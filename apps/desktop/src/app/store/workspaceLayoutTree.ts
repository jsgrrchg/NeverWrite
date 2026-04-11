export const MAX_EDITOR_PANES = 6;
export const DEFAULT_EDITOR_PANE_ID = "primary";

const LAYOUT_SIZE_EPSILON = 1e-6;

export type WorkspaceSplitDirection = "row" | "column";
export type WorkspaceMovePosition = "left" | "right" | "up" | "down";
export type WorkspacePanePath = number[];

export interface WorkspacePaneNode {
    type: "pane";
    id: string;
    paneId: string;
}

export interface WorkspaceSplitNode {
    type: "split";
    id: string;
    direction: WorkspaceSplitDirection;
    children: WorkspaceLayoutNode[];
    sizes: number[];
}

export type WorkspaceLayoutNode = WorkspacePaneNode | WorkspaceSplitNode;

function isProdBuild() {
    return import.meta.env?.PROD ?? false;
}

function createPaneNode(paneId: string): WorkspacePaneNode {
    return {
        type: "pane",
        id: paneId,
        paneId,
    };
}

function normalizeSizes(count: number, sizes?: readonly number[]) {
    const incoming = (sizes ?? []).filter(
        (value) => Number.isFinite(value) && value > 0,
    );

    if (incoming.length !== count || count <= 0) {
        return Array.from({ length: Math.max(0, count) }, () => 1 / count);
    }

    const total = incoming.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
        return Array.from({ length: count }, () => 1 / count);
    }

    return incoming.map((value) => value / total);
}

function getLegacyPaneSlot(paneId: string) {
    switch (paneId) {
        case "primary":
            return 1;
        case "secondary":
            return 2;
        case "tertiary":
            return 3;
        default:
            return null;
    }
}

function parseGeneratedPaneId(paneId: string) {
    const match = /^pane-(\d+)$/.exec(paneId.trim());
    if (!match) {
        return null;
    }
    const numeric = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function collectNodeIds(tree: WorkspaceLayoutNode, ids = new Set<string>()) {
    ids.add(tree.id);
    if (tree.type === "split") {
        tree.children.forEach((child) => collectNodeIds(child, ids));
    }
    return ids;
}

function collectPaneIds(
    tree: WorkspaceLayoutNode,
    paneIds: string[] = [],
): string[] {
    if (tree.type === "pane") {
        paneIds.push(tree.paneId);
        return paneIds;
    }

    tree.children.forEach((child) => collectPaneIds(child, paneIds));
    return paneIds;
}

function generateNextSplitId(tree: WorkspaceLayoutNode) {
    const taken = collectNodeIds(tree);
    let next = 1;
    while (taken.has(`split-${next}`)) {
        next += 1;
    }
    return `split-${next}`;
}

function mapLayoutNodeAtPath(
    tree: WorkspaceLayoutNode,
    path: WorkspacePanePath,
    updater: (node: WorkspaceLayoutNode) => WorkspaceLayoutNode,
): WorkspaceLayoutNode {
    if (path.length === 0) {
        return updater(tree);
    }

    if (tree.type !== "split") {
        return tree;
    }

    const [childIndex, ...rest] = path;
    return {
        ...tree,
        children: tree.children.map((child, index) =>
            index === childIndex
                ? mapLayoutNodeAtPath(child, rest, updater)
                : child,
        ),
    };
}

function removePaneNode(
    tree: WorkspaceLayoutNode,
    paneId: string,
): { nextTree: WorkspaceLayoutNode | null; removed: boolean } {
    if (tree.type === "pane") {
        return tree.paneId === paneId
            ? { nextTree: null, removed: true }
            : { nextTree: tree, removed: false };
    }

    let removed = false;
    const nextChildren: WorkspaceLayoutNode[] = [];
    const nextSizes: number[] = [];

    tree.children.forEach((child, index) => {
        const result = removePaneNode(child, paneId);
        removed ||= result.removed;
        if (result.nextTree) {
            nextChildren.push(result.nextTree);
            nextSizes.push(tree.sizes[index] ?? 0);
        }
    });

    if (!removed) {
        return { nextTree: tree, removed: false };
    }

    if (nextChildren.length === 0) {
        return { nextTree: null, removed: true };
    }

    if (nextChildren.length === 1) {
        return { nextTree: nextChildren[0] ?? null, removed: true };
    }

    return {
        nextTree: {
            ...tree,
            children: nextChildren,
            sizes: normalizeSizes(nextChildren.length, nextSizes),
        },
        removed: true,
    };
}

function insertPaneRelative(
    tree: WorkspaceLayoutNode,
    targetPaneId: string,
    position: WorkspaceMovePosition,
    paneToInsert: WorkspacePaneNode,
): WorkspaceLayoutNode {
    const path = findPanePath(tree, targetPaneId);
    if (!path) {
        return tree;
    }

    const direction =
        position === "left" || position === "right" ? "row" : "column";
    const insertBefore = position === "left" || position === "up";

    if (path.length === 0) {
        return {
            type: "split",
            id: generateNextSplitId(tree),
            direction,
            children: insertBefore
                ? [paneToInsert, tree]
                : [tree, paneToInsert],
            sizes: [0.5, 0.5],
        };
    }

    const parentPath = path.slice(0, -1);
    const targetChildIndex = path[path.length - 1] ?? 0;
    const parentNode = getNodeAtPath(tree, parentPath);
    if (!parentNode || parentNode.type !== "split") {
        return tree;
    }

    if (parentNode.direction === direction) {
        const anchorSize = parentNode.sizes[targetChildIndex] ?? 0;
        const insertionIndex = insertBefore
            ? targetChildIndex
            : targetChildIndex + 1;
        return mapLayoutNodeAtPath(tree, parentPath, (node) => {
            if (node.type !== "split") {
                return node;
            }

            const nextChildren = [...node.children];
            nextChildren.splice(insertionIndex, 0, paneToInsert);

            const nextSizes = [...node.sizes];
            const targetSize =
                anchorSize > 0 ? anchorSize : 1 / nextChildren.length;
            nextSizes[targetChildIndex] = targetSize / 2;
            nextSizes.splice(insertionIndex, 0, targetSize / 2);

            return {
                ...node,
                children: nextChildren,
                sizes: normalizeSizes(nextChildren.length, nextSizes),
            };
        });
    }

    return mapLayoutNodeAtPath(tree, parentPath, (node) => {
        if (node.type !== "split") {
            return node;
        }

        const targetNode = node.children[targetChildIndex];
        if (!targetNode) {
            return node;
        }

        const replacement: WorkspaceSplitNode = {
            type: "split",
            id: generateNextSplitId(tree),
            direction,
            children: insertBefore
                ? [paneToInsert, targetNode]
                : [targetNode, paneToInsert],
            sizes: [0.5, 0.5],
        };

        const nextChildren = [...node.children];
        nextChildren[targetChildIndex] = replacement;
        return {
            ...node,
            children: nextChildren,
        };
    });
}

function getNodeAtPath(
    tree: WorkspaceLayoutNode,
    path: WorkspacePanePath,
): WorkspaceLayoutNode | null {
    let current: WorkspaceLayoutNode | null = tree;
    for (const childIndex of path) {
        if (!current || current.type !== "split") {
            return null;
        }
        current = current.children[childIndex] ?? null;
    }
    return current;
}

function normalizeLayoutNode(tree: WorkspaceLayoutNode): WorkspaceLayoutNode {
    if (tree.type === "pane") {
        return tree;
    }

    const normalizedChildren = tree.children.map((child) =>
        normalizeLayoutNode(child),
    );
    const normalizedSizes = normalizeSizes(
        normalizedChildren.length,
        tree.sizes,
    );

    const flattenedChildren: WorkspaceLayoutNode[] = [];
    const flattenedSizes: number[] = [];

    normalizedChildren.forEach((child, index) => {
        const childSize = normalizedSizes[index] ?? 0;
        if (child.type === "split" && child.direction === tree.direction) {
            child.children.forEach((grandChild, grandIndex) => {
                flattenedChildren.push(grandChild);
                flattenedSizes.push(childSize * (child.sizes[grandIndex] ?? 0));
            });
            return;
        }

        flattenedChildren.push(child);
        flattenedSizes.push(childSize);
    });

    if (flattenedChildren.length === 1) {
        return flattenedChildren[0]!;
    }

    return {
        ...tree,
        children: flattenedChildren,
        sizes: normalizeSizes(flattenedChildren.length, flattenedSizes),
    };
}

export function createInitialLayout(
    paneId = DEFAULT_EDITOR_PANE_ID,
): WorkspaceLayoutNode {
    const tree = createPaneNode(paneId);
    assertLayoutInvariants(tree);
    return tree;
}

export function getNextGeneratedPaneId(
    existingPaneIds: readonly string[],
    options?: { maxPaneCount?: number },
) {
    const maxPaneCount = options?.maxPaneCount ?? MAX_EDITOR_PANES;
    if (existingPaneIds.length >= maxPaneCount) {
        return null;
    }

    const occupiedSlots = new Set<number>();
    existingPaneIds.forEach((paneId) => {
        const generatedSlot = parseGeneratedPaneId(paneId);
        if (generatedSlot !== null) {
            occupiedSlots.add(generatedSlot);
            return;
        }

        const legacySlot = getLegacyPaneSlot(paneId);
        if (legacySlot !== null) {
            occupiedSlots.add(legacySlot);
        }
    });

    for (let candidate = 1; candidate <= maxPaneCount; candidate += 1) {
        if (occupiedSlots.has(candidate)) {
            continue;
        }
        return `pane-${candidate}`;
    }

    return null;
}

export function findPanePath(
    tree: WorkspaceLayoutNode,
    paneId: string,
): WorkspacePanePath | null {
    if (tree.type === "pane") {
        return tree.paneId === paneId ? [] : null;
    }

    for (let index = 0; index < tree.children.length; index += 1) {
        const child = tree.children[index];
        if (!child) {
            continue;
        }
        const childPath = findPanePath(child, paneId);
        if (childPath) {
            return [index, ...childPath];
        }
    }

    return null;
}

export function normalizeLayoutTree(tree: WorkspaceLayoutNode) {
    const normalized = normalizeLayoutNode(tree);
    assertLayoutInvariants(normalized);
    return normalized;
}

export function splitPane(
    tree: WorkspaceLayoutNode,
    paneId: string,
    direction: WorkspaceSplitDirection,
    newPaneId: string,
) {
    const nextTree = insertPaneRelative(
        tree,
        paneId,
        direction === "row" ? "right" : "down",
        createPaneNode(newPaneId),
    );
    const normalized = normalizeLayoutTree(nextTree);
    assertLayoutInvariants(normalized);
    return normalized;
}

export function closePaneAndCollapse(
    tree: WorkspaceLayoutNode,
    paneId: string,
) {
    const result = removePaneNode(tree, paneId);
    const nextTree = result.nextTree;
    if (!result.removed || !nextTree) {
        assertLayoutInvariants(tree);
        return tree;
    }

    const normalized = normalizeLayoutTree(nextTree);
    assertLayoutInvariants(normalized);
    return normalized;
}

export function movePane(
    tree: WorkspaceLayoutNode,
    paneId: string,
    targetPaneId: string,
    position: WorkspaceMovePosition,
) {
    if (paneId === targetPaneId) {
        assertLayoutInvariants(tree);
        return tree;
    }
    if (!findPanePath(tree, paneId) || !findPanePath(tree, targetPaneId)) {
        assertLayoutInvariants(tree);
        return tree;
    }

    const removal = removePaneNode(tree, paneId);
    if (!removal.removed || !removal.nextTree) {
        assertLayoutInvariants(tree);
        return tree;
    }

    const inserted = insertPaneRelative(
        removal.nextTree,
        targetPaneId,
        position,
        createPaneNode(paneId),
    );
    const normalized = normalizeLayoutTree(inserted);
    assertLayoutInvariants(normalized);
    return normalized;
}

export function resizeSplit(
    tree: WorkspaceLayoutNode,
    splitId: string,
    sizes: readonly number[],
) {
    const splitPath = findNodePath(tree, splitId);
    if (!splitPath) {
        assertLayoutInvariants(tree);
        return tree;
    }

    const nextTree = mapLayoutNodeAtPath(tree, splitPath, (node) =>
        node.type === "split"
            ? {
                  ...node,
                  sizes: normalizeSizes(node.children.length, sizes),
              }
            : node,
    );
    const normalized = normalizeLayoutTree(nextTree);
    assertLayoutInvariants(normalized);
    return normalized;
}

export function balanceSplit(tree: WorkspaceLayoutNode, splitId?: string) {
    const rebalance = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
        if (node.type === "pane") {
            return node;
        }

        const children = node.children.map((child) => rebalance(child));
        if (splitId && node.id !== splitId) {
            return {
                ...node,
                children,
            };
        }

        return {
            ...node,
            children,
            sizes: normalizeSizes(children.length),
        };
    };

    const balanced = normalizeLayoutTree(rebalance(tree));
    assertLayoutInvariants(balanced);
    return balanced;
}

function findNodePath(
    tree: WorkspaceLayoutNode,
    nodeId: string,
): WorkspacePanePath | null {
    if (tree.id === nodeId) {
        return [];
    }

    if (tree.type === "pane") {
        return null;
    }

    for (let index = 0; index < tree.children.length; index += 1) {
        const child = tree.children[index];
        if (!child) {
            continue;
        }
        const childPath = findNodePath(child, nodeId);
        if (childPath) {
            return [index, ...childPath];
        }
    }

    return null;
}

export function assertLayoutInvariants(tree: WorkspaceLayoutNode): void {
    if (isProdBuild()) {
        return;
    }

    const seenNodeIds = new Set<string>();
    const seenPaneIds = new Set<string>();

    const visit = (node: WorkspaceLayoutNode) => {
        if (seenNodeIds.has(node.id)) {
            throw new Error(
                `Layout invariant violated: duplicate node id "${node.id}"`,
            );
        }
        seenNodeIds.add(node.id);

        if (node.type === "pane") {
            if (node.paneId.trim().length === 0) {
                throw new Error(
                    'Layout invariant violated: pane nodes require a non-empty "paneId"',
                );
            }
            if (seenPaneIds.has(node.paneId)) {
                throw new Error(
                    `Layout invariant violated: duplicate pane id "${node.paneId}"`,
                );
            }
            seenPaneIds.add(node.paneId);
            return;
        }

        if (node.children.length < 2) {
            throw new Error(
                `Layout invariant violated: split "${node.id}" must have at least two children`,
            );
        }
        if (node.sizes.length !== node.children.length) {
            throw new Error(
                `Layout invariant violated: split "${node.id}" must keep one size per child`,
            );
        }

        const total = node.sizes.reduce((sum, value) => sum + value, 0);
        if (!node.sizes.every((value) => Number.isFinite(value) && value > 0)) {
            throw new Error(
                `Layout invariant violated: split "${node.id}" contains invalid sizes`,
            );
        }
        if (Math.abs(total - 1) > LAYOUT_SIZE_EPSILON) {
            throw new Error(
                `Layout invariant violated: split "${node.id}" sizes must sum to 1`,
            );
        }

        node.children.forEach((child) => visit(child));
    };

    visit(tree);
}

export function getLayoutPaneIds(tree: WorkspaceLayoutNode) {
    return collectPaneIds(tree, []);
}
