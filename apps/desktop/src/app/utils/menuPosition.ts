export function getViewportSafeMenuPosition(
    x: number,
    y: number,
    width: number,
    height: number,
    padding = 8,
) {
    const maxX = Math.max(padding, window.innerWidth - width - padding);
    const maxY = Math.max(padding, window.innerHeight - height - padding);

    return {
        x: Math.min(Math.max(padding, x), maxX),
        y: Math.min(Math.max(padding, y), maxY),
    };
}

export function getViewportSafeCenteredPosition({
    centerX,
    topY,
    bottomY,
    width,
    height,
    padding = 8,
    gap = 10,
}: {
    centerX: number;
    topY: number;
    bottomY: number;
    width: number;
    height: number;
    padding?: number;
    gap?: number;
}): { x: number; y: number; placement: "top" | "bottom" } {
    const fitsAbove = topY - height - gap >= padding;
    const placement: "top" | "bottom" = fitsAbove ? "top" : "bottom";
    const rawX = centerX - width / 2;
    const rawY = fitsAbove ? topY - height - gap : bottomY + gap;

    const safe = getViewportSafeMenuPosition(rawX, rawY, width, height, padding);

    return {
        x: safe.x,
        y: safe.y,
        placement,
    };
}
