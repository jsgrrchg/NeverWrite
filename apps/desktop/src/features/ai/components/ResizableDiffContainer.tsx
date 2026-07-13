import { useCallback, useRef, useState, type ReactElement } from "react";

const DIFF_DEFAULT_HEIGHT = 200;
const DIFF_MIN_HEIGHT = 80;

export function ResizableDiffContainer({
    accent,
    children,
}: {
    readonly accent: string;
    readonly children: ReactElement;
}) {
    const [height, setHeight] = useState(DIFF_DEFAULT_HEIGHT);
    const dragging = useRef(false);
    const startY = useRef(0);
    const startH = useRef(0);

    const onPointerDown = useCallback(
        (event: React.PointerEvent) => {
            event.preventDefault();
            dragging.current = true;
            startY.current = event.clientY;
            startH.current = height;
            (event.target as HTMLElement).setPointerCapture(event.pointerId);
        },
        [height],
    );

    const onPointerMove = useCallback((event: React.PointerEvent) => {
        if (!dragging.current) return;
        const delta = event.clientY - startY.current;
        setHeight(Math.max(DIFF_MIN_HEIGHT, startH.current + delta));
    }, []);

    const onPointerUp = useCallback(() => {
        dragging.current = false;
    }, []);

    return (
        <div
            style={{
                borderBottom: `1px solid color-mix(in srgb, ${accent} 8%, var(--border))`,
            }}
        >
            <div style={{ maxHeight: height, overflowY: "auto" }}>{children}</div>
            <div
                aria-label="Resize diff preview"
                onMouseEnter={(event) => {
                    event.currentTarget.style.backgroundColor =
                        "color-mix(in srgb, var(--text-secondary) 10%, transparent)";
                }}
                onMouseLeave={(event) => {
                    event.currentTarget.style.backgroundColor = "transparent";
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                role="separator"
                style={{
                    alignItems: "center",
                    backgroundColor: "transparent",
                    cursor: "ns-resize",
                    display: "flex",
                    height: 6,
                    justifyContent: "center",
                    transition: "background-color 0.15s ease",
                }}
            >
                <div
                    aria-hidden="true"
                    style={{
                        backgroundColor: "var(--text-secondary)",
                        borderRadius: 1,
                        height: 2,
                        opacity: 0.3,
                        width: 32,
                    }}
                />
            </div>
        </div>
    );
}
