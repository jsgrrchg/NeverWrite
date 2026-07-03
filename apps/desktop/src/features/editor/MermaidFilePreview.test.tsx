import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderMermaidDiagram } from "./mermaid/mermaidRenderer";
import { renderComponent } from "../../test/test-utils";
import { MermaidFilePreview } from "./MermaidFilePreview";

vi.mock("./mermaid/mermaidRenderer", () => ({
    renderMermaidDiagram: vi.fn(),
}));

const mockedRenderMermaidDiagram = vi.mocked(renderMermaidDiagram);

function deferredRender() {
    let resolve!: (value: Awaited<ReturnType<typeof renderMermaidDiagram>>) => void;
    const promise = new Promise<Awaited<ReturnType<typeof renderMermaidDiagram>>>(
        (nextResolve) => {
            resolve = nextResolve;
        },
    );
    return { promise, resolve };
}

describe("MermaidFilePreview", () => {
    beforeEach(() => {
        mockedRenderMermaidDiagram.mockReset();
    });

    it("renders valid Mermaid output as SVG", async () => {
        const source = `flowchart TD
A --> B`;
        mockedRenderMermaidDiagram.mockResolvedValueOnce({
            status: "ok",
            svg: '<svg viewBox="0 0 10 10"><text>Flow</text></svg>',
        });

        renderComponent(<MermaidFilePreview source={source} tabId="tab-1" />);

        expect(screen.getByText("Rendering Mermaid diagram...")).toBeInTheDocument();

        expect(await screen.findByText("Flow")).not.toBeNull();
        expect(mockedRenderMermaidDiagram).toHaveBeenCalledWith(
            source,
            expect.stringMatching(/^mermaid-file-tab-1-/),
        );
    });

    it("shows Mermaid render errors inline", async () => {
        mockedRenderMermaidDiagram.mockResolvedValueOnce({
            status: "error",
            message: "Parse error",
        });

        renderComponent(<MermaidFilePreview source="not a diagram" tabId="tab-1" />);

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Mermaid diagram error",
        );
        expect(screen.getByText("Parse error")).toBeInTheDocument();
    });

    it("ignores stale render results after quick source changes", async () => {
        const oldSource = `flowchart TD
A --> B`;
        const newSource = `flowchart TD
A --> C`;
        const first = deferredRender();
        const second = deferredRender();
        mockedRenderMermaidDiagram
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);

        const { rerender } = renderComponent(
            <MermaidFilePreview source={oldSource} tabId="tab-1" />,
        );

        rerender(<MermaidFilePreview source={newSource} tabId="tab-1" />);

        await act(async () => {
            first.resolve({
                status: "ok",
                svg: '<svg><text>Old diagram</text></svg>',
            });
            second.resolve({
                status: "ok",
                svg: '<svg><text>New diagram</text></svg>',
            });
        });

        expect(await screen.findByText("New diagram")).not.toBeNull();
        expect(screen.queryByText("Old diagram")).not.toBeInTheDocument();
    });
});
