import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AIProviderIcon } from "./AIProviderIcon";

describe("AIProviderIcon", () => {
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
