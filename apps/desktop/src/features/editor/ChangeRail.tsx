import type { ChangeRailMarker } from "./changePresentationModel";

interface ChangeRailProps {
    markers: ChangeRailMarker[];
    activeMarkerKey: string | null;
    hoveredMarkerKey: string | null;
    onMarkerHover: (markerKey: string | null) => void;
    onMarkerClick: (markerKey: string) => void;
    onPreviousChange?: () => void;
    onNextChange?: () => void;
    hidden?: boolean;
}

export function ChangeRail({
    markers,
    activeMarkerKey,
    hoveredMarkerKey,
    onMarkerHover,
    onMarkerClick,
    onPreviousChange,
    onNextChange,
    hidden = false,
}: ChangeRailProps) {
    if (hidden || markers.length === 0) {
        return null;
    }

    return (
        <div
            className="flex h-full w-full flex-col items-center gap-2"
            aria-label="Change rail"
        >
            <div className="flex flex-col gap-1">
                {onPreviousChange && (
                    <button
                        type="button"
                        aria-label="Previous change"
                        onClick={onPreviousChange}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-[11px]"
                        style={railNavButtonStyle}
                    >
                        ↑
                    </button>
                )}
                {onNextChange && (
                    <button
                        type="button"
                        aria-label="Next change"
                        onClick={onNextChange}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-[11px]"
                        style={railNavButtonStyle}
                    >
                        ↓
                    </button>
                )}
            </div>

            <div
                className="relative min-h-0 flex-1 w-2.5 rounded-full"
                style={{
                    background:
                        "color-mix(in srgb, var(--border) 40%, transparent)",
                }}
            >
                {markers.map((marker, index) => {
                    const isActive = marker.key === activeMarkerKey;
                    const isHovered = marker.key === hoveredMarkerKey;
                    const markerHeight = Math.max(marker.heightRatio * 100, 2);

                    return (
                        <button
                            key={marker.key}
                            type="button"
                            aria-label={`Change ${index + 1}`}
                            aria-current={isActive ? "true" : undefined}
                            data-active={isActive ? "true" : "false"}
                            data-hovered={isHovered ? "true" : "false"}
                            className="absolute left-0.5 right-0.5 rounded-full border-0 p-0"
                            style={{
                                top: `${marker.topRatio * 100}%`,
                                height: `${markerHeight}%`,
                                minHeight: 2,
                                background: getMarkerColor(marker.kind),
                                opacity: isActive
                                    ? 1
                                    : isHovered
                                      ? 0.92
                                      : marker.reviewState === "pending"
                                        ? 0.65
                                        : 0.78,
                                boxShadow: isActive
                                    ? "0 0 0 1px color-mix(in srgb, white 55%, transparent), 0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent)"
                                    : isHovered
                                      ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)"
                                      : "none",
                                transform:
                                    isActive || isHovered
                                        ? "scaleX(1.14)"
                                        : "scaleX(1)",
                                transition:
                                    "opacity 140ms ease, transform 140ms ease, box-shadow 140ms ease",
                            }}
                            onMouseEnter={() => onMarkerHover(marker.key)}
                            onMouseLeave={() => onMarkerHover(null)}
                            onFocus={() => onMarkerHover(marker.key)}
                            onBlur={() => onMarkerHover(null)}
                            onClick={() => onMarkerClick(marker.key)}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function getMarkerColor(kind: ChangeRailMarker["kind"]) {
    switch (kind) {
        case "add":
            return "var(--diff-add)";
        case "delete":
            return "var(--diff-remove)";
        default:
            return "var(--diff-update)";
    }
}

const railNavButtonStyle = {
    border: "1px solid color-mix(in srgb, var(--border) 75%, transparent)",
    backgroundColor: "color-mix(in srgb, var(--bg-secondary) 82%, var(--bg-primary))",
    color: "var(--text-secondary)",
    boxShadow: "0 1px 0 color-mix(in srgb, white 6%, transparent)",
} as const;
