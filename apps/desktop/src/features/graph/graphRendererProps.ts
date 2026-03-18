import type { QualityProfile } from "./graphQuality";
import type { GraphMode } from "./graphSettingsStore";
import type {
    GraphRenderSnapshot,
    GraphRendererCallbacks,
    GraphRendererSelectionState,
} from "./graphRenderModel";

export interface GraphRendererProps {
    snapshot: GraphRenderSnapshot;
    isVisible: boolean;
    graphMode: GraphMode;
    localDepth: number;
    qualityProfile: QualityProfile;
    selection: GraphRendererSelectionState;
    canvasTheme: {
        labelRgb: [number, number, number];
        linkColor: string;
        particleColor: string;
    };
    linkThickness: number;
    arrows: boolean;
    centerForce: number;
    repelForce: number;
    linkForce: number;
    linkDistance: number;
    nodeSize: number;
    glowIntensity: number;
    showTitles: boolean;
    textFadeThreshold: number;
    layoutKey: string;
    restoredFromCache: boolean;
    shouldRunSimulation: boolean;
    cooldownTicks: number;
    callbacks: GraphRendererCallbacks;
}
