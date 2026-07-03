import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mermaid", () => ({
    default: {
        initialize: vi.fn(),
        render: vi.fn(),
    },
}));

describe("mermaidRenderer", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it("initializes Mermaid with safe preview defaults once", async () => {
        const { initializeMermaidRenderer } = await import("./mermaidRenderer");
        const { default: mermaid } = await import("mermaid");
        const mockedMermaid = vi.mocked(mermaid);

        await initializeMermaidRenderer();
        await initializeMermaidRenderer();

        expect(mockedMermaid.initialize).toHaveBeenCalledTimes(1);
        expect(mockedMermaid.initialize).toHaveBeenCalledWith({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "base",
        });
    });

    it("renders a diagram as SVG", async () => {
        const { renderMermaidDiagram } = await import("./mermaidRenderer");
        const { default: mermaid } = await import("mermaid");
        const mockedMermaid = vi.mocked(mermaid);

        mockedMermaid.render.mockResolvedValueOnce({
            svg: "<svg>diagram</svg>",
            bindFunctions: undefined,
            diagramType: "flowchart",
        });

        await expect(
            renderMermaidDiagram("flowchart TD\nA --> B", "mermaid-test"),
        ).resolves.toEqual({
            status: "ok",
            svg: "<svg>diagram</svg>",
        });
        expect(mockedMermaid.render).toHaveBeenCalledWith(
            "mermaid-test",
            "flowchart TD\nA --> B",
        );
    });

    it("returns a render error message without throwing", async () => {
        const { renderMermaidDiagram } = await import("./mermaidRenderer");
        const { default: mermaid } = await import("mermaid");
        const mockedMermaid = vi.mocked(mermaid);

        mockedMermaid.render.mockRejectedValueOnce(new Error("Parse error"));

        await expect(
            renderMermaidDiagram("not a diagram", "mermaid-error"),
        ).resolves.toEqual({
            status: "error",
            message: "Parse error",
        });
    });
});
