export interface TerminalGridSize {
    cols: number;
    rows: number;
}

const DEFAULT_CELL_WIDTH = 8.2;
const DEFAULT_CELL_HEIGHT = 18;
const MIN_COLS = 40;
const MIN_ROWS = 8;

export function getTerminalGridSize(
    element: HTMLElement | null,
): TerminalGridSize {
    if (!element) {
        return { cols: 120, rows: 24 };
    }

    const computed = window.getComputedStyle(element);
    const paddingX =
        parseFloat(computed.paddingLeft || "0") +
        parseFloat(computed.paddingRight || "0");
    const paddingY =
        parseFloat(computed.paddingTop || "0") +
        parseFloat(computed.paddingBottom || "0");

    const usableWidth = Math.max(0, element.clientWidth - paddingX);
    const usableHeight = Math.max(0, element.clientHeight - paddingY);

    return {
        cols: Math.max(MIN_COLS, Math.floor(usableWidth / DEFAULT_CELL_WIDTH)),
        rows: Math.max(
            MIN_ROWS,
            Math.floor(usableHeight / DEFAULT_CELL_HEIGHT),
        ),
    };
}
