import { useState, type ReactElement } from "react";
import {
    DIFF_ZOOM_MAX,
    DIFF_ZOOM_MIN,
    DIFF_ZOOM_STEP,
    stepDiffZoom,
} from "../diff/reviewDiff";

function DiffZoomButton({
    accent,
    ariaLabel,
    disabled,
    onClick,
    children,
}: {
    accent: string;
    ariaLabel: string;
    disabled: boolean;
    onClick: () => void;
    children: ReactElement;
}) {
    const [hovered, setHovered] = useState(false);
    const interactive = !disabled;
    return (
        <button
            type="button"
            aria-label={ariaLabel}
            title={ariaLabel}
            disabled={disabled}
            onClick={onClick}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors"
            style={{
                color: interactive ? accent : "var(--text-secondary)",
                opacity: interactive ? (hovered ? 1 : 0.7) : 0.35,
                backgroundColor:
                    hovered && interactive
                        ? `color-mix(in srgb, ${accent} 12%, transparent)`
                        : "transparent",
                border: "none",
                cursor: interactive ? "pointer" : "not-allowed",
            }}
        >
            {children}
        </button>
    );
}

export function DiffZoomControls({
    accent,
    zoom,
    onZoomChange,
}: {
    accent: string;
    zoom: number;
    onZoomChange: (next: number) => void;
}) {
    const canDecrease = zoom > DIFF_ZOOM_MIN;
    const canIncrease = zoom < DIFF_ZOOM_MAX;
    return (
        <>
            <DiffZoomButton
                accent={accent}
                ariaLabel="Decrease diff zoom"
                disabled={!canDecrease}
                onClick={() =>
                    onZoomChange(stepDiffZoom(zoom, -DIFF_ZOOM_STEP))
                }
            >
                <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    aria-hidden="true"
                >
                    <path d="M2.5 5h5" />
                </svg>
            </DiffZoomButton>
            <DiffZoomButton
                accent={accent}
                ariaLabel="Increase diff zoom"
                disabled={!canIncrease}
                onClick={() => onZoomChange(stepDiffZoom(zoom, DIFF_ZOOM_STEP))}
            >
                <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    aria-hidden="true"
                >
                    <path d="M2.5 5h5M5 2.5v5" />
                </svg>
            </DiffZoomButton>
        </>
    );
}
