import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../test/test-utils";
import {
    DeveloperPanelHeader,
    type DeveloperPanelTabItem,
} from "./DeveloperPanelHeader";

function buildTabs(activeTabId: string): DeveloperPanelTabItem[] {
    return Array.from({ length: 8 }, (_, index) => {
        const id = `tab-${index + 1}`;
        return {
            id,
            title: `zsh ${index + 1}`,
            status: "running" as const,
            hasCustomTitle: false,
            isActive: id === activeTabId,
        };
    });
}

function renderHeader(activeTabId: string) {
    return renderComponent(
        <DeveloperPanelHeader
            tabs={buildTabs(activeTabId)}
            activeTabId={activeTabId}
            canClear
            onClear={vi.fn()}
            onNewTab={vi.fn()}
            onSelectTab={vi.fn()}
            onRenameTab={vi.fn()}
            onDuplicateTab={vi.fn()}
            onResetTabTitle={vi.fn()}
            onReorderTabs={vi.fn()}
            onCloseOthers={vi.fn()}
            onCloseTab={vi.fn()}
            onRestart={vi.fn()}
            onRestartTab={vi.fn()}
            onHide={vi.fn()}
        />,
    );
}

describe("DeveloperPanelHeader", () => {
    it("scrolls the active terminal tab into view when the strip overflows", () => {
        const originalScrollLeft = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "scrollLeft",
        );
        const originalClientWidth = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "clientWidth",
        );
        const originalScrollWidth = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "scrollWidth",
        );
        const originalOffsetLeft = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetLeft",
        );
        const originalOffsetWidth = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetWidth",
        );
        const originalScrollTo = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "scrollTo",
        );
        const scrollTo = vi.fn();

        Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
            configurable: true,
            get() {
                return 0;
            },
        });
        Object.defineProperty(HTMLElement.prototype, "clientWidth", {
            configurable: true,
            get() {
                return this.getAttribute("role") === "tablist" ? 320 : 0;
            },
        });
        Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
            configurable: true,
            get() {
                return this.getAttribute("role") === "tablist" ? 1_344 : 0;
            },
        });
        Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
            configurable: true,
            get() {
                const match = this.textContent?.match(/zsh (\d+)/);
                if (!match) return 0;
                return (Number(match[1]) - 1) * 168;
            },
        });
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
            configurable: true,
            get() {
                return this.getAttribute("role") === "tab" ? 168 : 0;
            },
        });
        Object.defineProperty(HTMLElement.prototype, "scrollTo", {
            configurable: true,
            value: scrollTo,
        });

        renderHeader("tab-8");

        expect(scrollTo).toHaveBeenCalledWith({
            left: 868,
            behavior: "smooth",
        });

        if (originalScrollLeft) {
            Object.defineProperty(
                HTMLElement.prototype,
                "scrollLeft",
                originalScrollLeft,
            );
        }
        if (originalClientWidth) {
            Object.defineProperty(
                HTMLElement.prototype,
                "clientWidth",
                originalClientWidth,
            );
        }
        if (originalScrollWidth) {
            Object.defineProperty(
                HTMLElement.prototype,
                "scrollWidth",
                originalScrollWidth,
            );
        }
        if (originalOffsetLeft) {
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetLeft",
                originalOffsetLeft,
            );
        }
        if (originalOffsetWidth) {
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetWidth",
                originalOffsetWidth,
            );
        }
        if (originalScrollTo) {
            Object.defineProperty(
                HTMLElement.prototype,
                "scrollTo",
                originalScrollTo,
            );
        }
    });

    it("supports inline rename and drag reorder", () => {
        const onRenameTab = vi.fn();
        const onReorderTabs = vi.fn();

        renderComponent(
            <DeveloperPanelHeader
                tabs={buildTabs("tab-2")}
                activeTabId="tab-2"
                canClear
                onClear={vi.fn()}
                onNewTab={vi.fn()}
                onSelectTab={vi.fn()}
                onRenameTab={onRenameTab}
                onDuplicateTab={vi.fn()}
                onResetTabTitle={vi.fn()}
                onReorderTabs={onReorderTabs}
                onCloseOthers={vi.fn()}
                onCloseTab={vi.fn()}
                onRestart={vi.fn()}
                onRestartTab={vi.fn()}
                onHide={vi.fn()}
            />,
        );

        fireEvent.doubleClick(screen.getByRole("tab", { name: "zsh 2" }));

        const renameInput = screen.getByDisplayValue("zsh 2");
        fireEvent.change(renameInput, { target: { value: "Logs" } });
        fireEvent.keyDown(renameInput, { key: "Enter" });

        expect(onRenameTab).toHaveBeenCalledWith("tab-2", "Logs");

        const transfer = {
            effectAllowed: "",
            setData: vi.fn(),
        };

        fireEvent.dragStart(screen.getByRole("tab", { name: "zsh 2" }), {
            dataTransfer: transfer,
        });
        fireEvent.dragOver(screen.getByRole("tab", { name: "zsh 1" }), {
            dataTransfer: transfer,
        });

        expect(onReorderTabs).toHaveBeenCalledWith(1, 0);
    });
});
