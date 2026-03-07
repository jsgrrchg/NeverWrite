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
