export function resolveNavigationRailTopPercent(
    index: number,
    itemCount: number,
) {
    if (itemCount <= 1) return 0;
    return (
        (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) *
        100
    );
}

export function resolveNavigationRailIndexFromPointer(input: {
    itemCount: number;
    railTop: number;
    railHeight: number;
    pointerY: number;
}) {
    if (input.itemCount <= 0 || input.railHeight <= 0) return null;
    if (input.itemCount === 1) return 0;

    const progress = Math.max(
        0,
        Math.min(1, (input.pointerY - input.railTop) / input.railHeight),
    );
    return Math.max(
        0,
        Math.min(
            input.itemCount - 1,
            Math.round(progress * (input.itemCount - 1)),
        ),
    );
}

