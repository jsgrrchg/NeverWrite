import type mermaid from "mermaid";

export type MermaidRenderResult =
    | {
          status: "ok";
          svg: string;
      }
    | {
          status: "error";
          message: string;
      };

let mermaidInitialized = false;
let mermaidModulePromise: Promise<typeof mermaid> | null = null;

const BASE_MERMAID_CONFIG = {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
} as const;

export async function initializeMermaidRenderer(): Promise<typeof mermaid> {
    const mermaidModule = await loadMermaidModule();
    if (mermaidInitialized) return mermaidModule;

    mermaidModule.initialize(BASE_MERMAID_CONFIG);
    mermaidInitialized = true;
    return mermaidModule;
}

export async function renderMermaidDiagram(
    source: string,
    id: string,
): Promise<MermaidRenderResult> {
    try {
        const mermaidModule = await initializeMermaidRenderer();
        mermaidModule.initialize({
            ...BASE_MERMAID_CONFIG,
            themeVariables: getMermaidThemeVariables(),
        });
        const { svg } = await mermaidModule.render(id, source);
        return { status: "ok", svg };
    } catch (error) {
        return {
            status: "error",
            message: getMermaidErrorMessage(error),
        };
    }
}

async function loadMermaidModule(): Promise<typeof mermaid> {
    if (!mermaidModulePromise) {
        mermaidModulePromise = import("mermaid").then((module) => module.default);
    }
    return mermaidModulePromise;
}

function getMermaidErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    if (typeof error === "string" && error.trim()) {
        return error;
    }
    return "Unable to render Mermaid diagram.";
}

function getMermaidThemeVariables() {
    if (typeof document === "undefined") return undefined;

    const styles = getComputedStyle(document.documentElement);
    const value = (name: string, fallback: string) =>
        styles.getPropertyValue(name).trim() || fallback;

    const bgPrimary = value("--bg-primary", "#ffffff");
    const bgSecondary = value("--bg-secondary", "#f8fafc");
    const bgTertiary = value("--bg-tertiary", "#f1f5f9");
    const textPrimary = value("--text-primary", "#111827");
    const textSecondary = value("--text-secondary", "#4b5563");
    const border = value("--border", "#d1d5db");
    const accent = value("--accent", "#3b82f6");

    return {
        background: bgPrimary,
        mainBkg: bgSecondary,
        secondBkg: bgTertiary,
        primaryColor: bgSecondary,
        primaryTextColor: textPrimary,
        primaryBorderColor: border,
        secondaryColor: bgTertiary,
        secondaryTextColor: textPrimary,
        secondaryBorderColor: border,
        tertiaryColor: bgPrimary,
        tertiaryTextColor: textPrimary,
        tertiaryBorderColor: border,
        lineColor: textSecondary,
        textColor: textPrimary,
        nodeTextColor: textPrimary,
        edgeLabelBackground: bgPrimary,
        clusterBkg: bgSecondary,
        clusterBorder: border,
        noteBkgColor: bgTertiary,
        noteTextColor: textPrimary,
        noteBorderColor: border,
        actorBkg: bgSecondary,
        actorTextColor: textPrimary,
        actorBorder: border,
        actorLineColor: border,
        signalColor: textSecondary,
        signalTextColor: textPrimary,
        labelBoxBkgColor: bgSecondary,
        labelBoxBorderColor: border,
        labelTextColor: textPrimary,
        loopTextColor: textPrimary,
        activationBkgColor: bgTertiary,
        activationBorderColor: border,
        sequenceNumberColor: bgPrimary,
        sectionBkgColor: bgTertiary,
        altSectionBkgColor: bgSecondary,
        gridColor: border,
        c0: accent,
        c1: textSecondary,
        c2: bgTertiary,
    };
}
