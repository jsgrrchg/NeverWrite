export function normalizeAgentOrder(
    order: readonly string[],
    allowedIds?: ReadonlySet<string>,
) {
    const seen = new Set<string>();
    return order.filter((id) => {
        if (!id || seen.has(id) || (allowedIds && !allowedIds.has(id))) {
            return false;
        }
        seen.add(id);
        return true;
    });
}

export function removeAgentFromOrder(order: readonly string[], sessionId: string) {
    return normalizeAgentOrder(order).filter((id) => id !== sessionId);
}

export function insertAgentIntoOrder(
    order: readonly string[],
    sessionId: string,
    destinationIndex: number,
) {
    const next = removeAgentFromOrder(order, sessionId);
    next.splice(Math.max(0, Math.min(destinationIndex, next.length)), 0, sessionId);
    return next;
}

export function reorderVisiblePinnedAgents(
    fullOrder: readonly string[],
    visibleIds: readonly string[],
    sessionId: string,
    destinationIndex: number,
) {
    const normalizedFull = normalizeAgentOrder(fullOrder);
    const visible = new Set(visibleIds);
    const visibleSlots = normalizedFull
        .map((id, index) => (visible.has(id) ? index : -1))
        .filter((index) => index >= 0);
    const preferredVisible = [
        ...normalizedFull.filter((id) => visible.has(id)),
        ...visibleIds.filter((id) => !normalizedFull.includes(id)),
    ];
    const reordered = insertAgentIntoOrder(
        preferredVisible,
        sessionId,
        destinationIndex,
    );
    const result = [...normalizedFull];
    for (let index = 0; index < visibleSlots.length; index += 1) {
        const id = reordered[index];
        if (id) result[visibleSlots[index]] = id;
    }
    for (const id of reordered.slice(visibleSlots.length)) result.push(id);
    return normalizeAgentOrder(result);
}
