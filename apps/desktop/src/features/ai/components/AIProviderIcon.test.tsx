import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AIProviderIcon } from "./AIProviderIcon";

describe("AIProviderIcon", () => {
    it("uses the official Pi mark for the Pi ACP runtime", () => {
        const { container } = render(<AIProviderIcon runtimeId="pi-acp" />);

        expect(container.querySelector("svg")).toHaveAttribute(
            "viewBox",
            "0 0 800 800",
        );
        expect(container.querySelectorAll("path")).toHaveLength(1);
        expect(container.querySelector("path")).toHaveAttribute(
            "fill",
            "currentColor",
        );
        expect(container.querySelector("path")).toHaveAttribute(
            "fill-rule",
            "evenodd",
        );
    });

    it("keeps the Kilo mark for Kilo runtimes", () => {
        const { container } = render(<AIProviderIcon runtimeId="kilo-acp" />);

        expect(container.querySelectorAll("line")).toHaveLength(3);
        expect(container.querySelector("circle")).not.toBeInTheDocument();
    });

    it("uses a settings mark for custom runtimes", () => {
        const { container } = render(
            <AIProviderIcon runtimeId="custom-acp:user-agent" />,
        );

        expect(container.querySelector("circle")).toBeInTheDocument();
        expect(container.querySelectorAll("line")).toHaveLength(0);
    });
});
