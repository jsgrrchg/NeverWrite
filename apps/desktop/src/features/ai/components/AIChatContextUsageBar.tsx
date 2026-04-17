import type { AITokenUsage } from "../types";

const WARNING_THRESHOLD = 0.85;
const EXCEEDED_THRESHOLD = 1;
const BAR_HEIGHT = 2;

interface AIChatContextUsageBarProps {
    usage?: AITokenUsage | null;
    // Inner corner radius of the composer shell (outer radius minus its 1px
    // border) so the bar follows the rounded bottom edge cleanly.
    cornerRadius?: number;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function formatCompactTokenCount(value: number) {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
    }

    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
    }

    return value.toString();
}

function formatPercent(value: number) {
    return `${Math.round(value * 100)}%`;
}

function formatCost(amount: number, currency: string) {
    const upperCurrency = currency.toUpperCase();

    try {
        return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: upperCurrency,
            maximumFractionDigits: 4,
        }).format(amount);
    } catch {
        return `${upperCurrency} ${amount.toFixed(4)}`;
    }
}

// Tones match the palette used across the chat surface: theme accent by
// default, `#d97706` (chatPillPalette file) on warning and `#dc2626`
// (AIChatRuntimeBanner error) when the window is exceeded.
function getTone(ratio: number) {
    if (ratio >= EXCEEDED_THRESHOLD) return "#dc2626";
    if (ratio >= WARNING_THRESHOLD) return "#d97706";
    return "var(--accent)";
}

export function AIChatContextUsageBar({
    usage,
    cornerRadius = 11,
}: AIChatContextUsageBarProps) {
    if (!usage || usage.size <= 0) {
        return null;
    }

    const rawRatio = usage.used / usage.size;
    const ratio = clamp(rawRatio, 0, 1);
    const percent = formatPercent(rawRatio);
    const usedTokens = formatCompactTokenCount(usage.used);
    const sizeTokens = formatCompactTokenCount(usage.size);
    const titleLines = [
        `Context window: ${percent} used`,
        `${usedTokens} / ${sizeTokens} tokens`,
    ];
    const ariaParts = [
        `Context window ${percent} used.`,
        `${usedTokens} of ${sizeTokens} tokens.`,
    ];

    if (usage.cost) {
        const formattedCost = formatCost(usage.cost.amount, usage.cost.currency);
        titleLines.push(`Estimated cost: ${formattedCost}`);
        ariaParts.push(`Estimated cost ${formattedCost}.`);
    }

    const tone = getTone(rawRatio);
    const shouldGlow = rawRatio >= WARNING_THRESHOLD;

    return (
        <div
            role="progressbar"
            aria-label={ariaParts.join(" ")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(rawRatio * 100)}
            title={titleLines.join("\n")}
            className="pointer-events-none absolute left-0 right-0"
            style={{
                bottom: 0,
                height: BAR_HEIGHT,
                borderBottomLeftRadius: cornerRadius,
                borderBottomRightRadius: cornerRadius,
                overflow: "hidden",
                zIndex: 1,
            }}
        >
            <div
                style={{
                    width: `${ratio * 100}%`,
                    height: "100%",
                    backgroundColor: tone,
                    boxShadow: shouldGlow
                        ? `0 0 8px ${tone}, 0 0 2px ${tone}`
                        : "none",
                    transition:
                        "width 220ms ease, background-color 160ms ease, box-shadow 160ms ease",
                }}
            />
        </div>
    );
}
