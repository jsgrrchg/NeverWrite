import { useLayoutEffect, useRef, useState } from "react";
import { MetaBadge } from "./EditorHeader";
import { getCompactLocationSegments } from "./locationBreadcrumbUtils";

type LocationBreadcrumbProps = {
    segments: string[];
};

export function LocationBreadcrumb({ segments }: LocationBreadcrumbProps) {
    const rootRef = useRef<HTMLSpanElement | null>(null);
    const measurementRef = useRef<HTMLSpanElement | null>(null);
    const [isCompact, setIsCompact] = useState(false);
    const fullPath = segments.join(" / ");
    const compactPath = getCompactLocationSegments(segments).join(" / ");

    useLayoutEffect(() => {
        const root = rootRef.current;
        const measurement = measurementRef.current;
        if (!root || !measurement) return;

        const updateLayout = () => {
            const availableWidth = root.clientWidth;
            // JSDOM has no layout. Leave the complete label visible there so
            // unit tests retain meaningful output while browsers measure it.
            if (availableWidth === 0) return;
            setIsCompact(measurement.offsetWidth > availableWidth);
        };

        updateLayout();

        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(updateLayout);
        observer.observe(root);

        return () => observer.disconnect();
    }, [fullPath]);

    return (
        <span
            ref={rootRef}
            style={{
                display: "inline-flex",
                flex: "1 1 auto",
                minWidth: 0,
                maxWidth: "100%",
            }}
        >
            <span
                ref={measurementRef}
                aria-hidden="true"
                style={{
                    position: "absolute",
                    visibility: "hidden",
                    whiteSpace: "nowrap",
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    padding: "0 8px",
                    border: "1px solid transparent",
                }}
            >
                {fullPath}
            </span>
            <MetaBadge
                label={isCompact ? compactPath : fullPath}
                title={fullPath}
                truncate
            />
        </span>
    );
}
