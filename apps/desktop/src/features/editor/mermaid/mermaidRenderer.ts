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

export async function initializeMermaidRenderer(): Promise<typeof mermaid> {
    const mermaidModule = await loadMermaidModule();
    if (mermaidInitialized) return mermaidModule;

    mermaidModule.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
    });
    mermaidInitialized = true;
    return mermaidModule;
}

export async function renderMermaidDiagram(
    source: string,
    id: string,
): Promise<MermaidRenderResult> {
    try {
        const mermaidModule = await initializeMermaidRenderer();
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
