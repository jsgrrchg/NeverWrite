import type {
    GraphQualityMode,
    GraphQualitySetting,
} from "./graphSettingsStore";

export interface QualityProfile {
    mode: GraphQualityMode;
    enableHover: boolean;
    enableNodeDrag: boolean;
    customPointerArea: boolean;
    enablePointerInteraction: boolean;
    showNodeGlow: boolean;
    simplifiedGlow: boolean;
    showLabelsOnZoom: boolean;
    showLabelsOnHover: boolean;
    particleCount: number;
    particleWidth: number;
    particleSpeed: number;
    linkWidthMul: number;
    linkColorAlpha: number;
    pointerPadding: number;
    overviewShapes: boolean;
    defaultCooldownTicks: number;
}

export function resolveQualityMode(
    qualitySetting: GraphQualitySetting,
    totalNodes: number,
): GraphQualityMode {
    if (qualitySetting !== "auto") return qualitySetting;
    if (totalNodes <= 5_000) return "cinematic";
    if (totalNodes <= 20_000) return "balanced";
    if (totalNodes <= 40_000) return "large-vault";
    return "overview";
}

export function qualityProfileForMode(mode: GraphQualityMode): QualityProfile {
    switch (mode) {
        case "cinematic":
            return {
                mode,
                enableHover: true,
                enableNodeDrag: true,
                customPointerArea: true,
                enablePointerInteraction: true,
                showNodeGlow: true,
                simplifiedGlow: false,
                showLabelsOnZoom: true,
                showLabelsOnHover: true,
                particleCount: 0,
                particleWidth: 0,
                particleSpeed: 0,
                linkWidthMul: 1,
                linkColorAlpha: 1,
                pointerPadding: 3,
                overviewShapes: false,
                defaultCooldownTicks: 100,
            };
        case "balanced":
            return {
                mode,
                enableHover: true,
                enableNodeDrag: true,
                customPointerArea: false,
                enablePointerInteraction: true,
                showNodeGlow: true,
                simplifiedGlow: true,
                showLabelsOnZoom: false,
                showLabelsOnHover: true,
                particleCount: 0,
                particleWidth: 0,
                particleSpeed: 0,
                linkWidthMul: 0.9,
                linkColorAlpha: 0.8,
                pointerPadding: 1,
                overviewShapes: false,
                defaultCooldownTicks: 80,
            };
        case "large-vault":
            return {
                mode,
                enableHover: false,
                enableNodeDrag: false,
                customPointerArea: false,
                enablePointerInteraction: true,
                showNodeGlow: false,
                simplifiedGlow: true,
                showLabelsOnZoom: false,
                showLabelsOnHover: false,
                particleCount: 0,
                particleWidth: 0,
                particleSpeed: 0,
                linkWidthMul: 0.75,
                linkColorAlpha: 0.55,
                pointerPadding: 0,
                overviewShapes: false,
                defaultCooldownTicks: 48,
            };
        case "overview":
            return {
                mode,
                enableHover: false,
                enableNodeDrag: false,
                customPointerArea: false,
                enablePointerInteraction: true,
                showNodeGlow: false,
                simplifiedGlow: true,
                showLabelsOnZoom: false,
                showLabelsOnHover: false,
                particleCount: 0,
                particleWidth: 0,
                particleSpeed: 0,
                linkWidthMul: 0.6,
                linkColorAlpha: 0.4,
                pointerPadding: 0,
                overviewShapes: true,
                defaultCooldownTicks: 0,
            };
    }
}
