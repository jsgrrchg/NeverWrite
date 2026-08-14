import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createDefaultLayoutState,
    useLayoutStore,
} from "../../app/store/layoutStore";
import { RightSidebarShell } from "./RightSidebarShell";
import { SidebarShell } from "./SidebarShell";

vi.mock("../../features/vault/FileTree", () => ({
    FileTree: () => <div data-testid="files-content" />,
}));
vi.mock("../../features/ai/AgentsSidebarPanel", () => ({
    AgentsSidebarPanel: () => <div data-testid="agents-content" />,
}));
vi.mock("../../features/tags/TagsPanel", () => ({
    TagsPanel: () => <div data-testid="tags-content" />,
}));
vi.mock("../../features/bookmarks/BookmarksPanel", () => ({
    BookmarksPanel: () => <div data-testid="bookmarks-content" />,
}));
vi.mock("../../features/maps/MapsPanel", () => ({
    MapsPanel: () => <div data-testid="maps-content" />,
}));
vi.mock("../../features/notes/OutlinePanel", () => ({
    OutlinePanel: () => <div data-testid="outline-content" />,
}));
vi.mock("../../features/notes/LinksPanel", () => ({
    LinksPanel: () => <div data-testid="links-content" />,
}));
vi.mock("../../features/vault/VaultSwitcher", () => ({
    VaultSwitcher: () => <div data-testid="vault-switcher" />,
}));
vi.mock("../../features/updates/store", () => ({
    useAppUpdateStore: (selector: (state: { status: null }) => unknown) =>
        selector({ status: null }),
}));
describe("sidebar shells", () => {
    beforeEach(() => {
        useLayoutStore.setState({
            ...createDefaultLayoutState(),
            rightPanelExpanded: false,
        });
    });

    it("renders the default views on their canonical sides", () => {
        render(
            <>
                <SidebarShell onOpenSettings={vi.fn()} />
                <RightSidebarShell />
            </>,
        );
        const left = screen.getByTestId("sidebar-shell");
        const right = screen.getByTestId("right-sidebar-shell");
        expect(
            within(left).getAllByRole("button", {
                name: /Files|Agents|Tags|Bookmarks|Maps/,
            }),
        ).toHaveLength(5);
        expect(
            within(right).getAllByRole("button", { name: /Outline|Links/ }),
        ).toHaveLength(2);
        expect(screen.getAllByTestId("files-content")).toHaveLength(1);
        expect(within(right).getByText("No note open")).toBeInTheDocument();
        expect(screen.getByTestId("vault-switcher")).toBeInTheDocument();
    });

    it("mounts moved content only in its owning shell and compacts contextual tabs", () => {
        useLayoutStore.getState().moveSidebarView("files", "right");
        render(
            <>
                <SidebarShell onOpenSettings={vi.fn()} />
                <RightSidebarShell />
            </>,
        );
        const right = screen.getByTestId("right-sidebar-shell");
        expect(within(right).getByTestId("files-content")).toBeInTheDocument();
        expect(screen.getAllByTestId("files-content")).toHaveLength(1);
        expect(
            within(right).getByRole("button", { name: "Outline" }),
        ).not.toHaveTextContent("Outline");
        expect(
            within(right).getByRole("button", { name: "Links" }),
        ).not.toHaveTextContent("Links");
    });

    it("switches one body per side and hides the left footer for Maps", () => {
        render(<SidebarShell onOpenSettings={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "Maps" }));
        expect(screen.getByTestId("maps-content")).toBeInTheDocument();
        expect(screen.queryByTestId("files-content")).not.toBeInTheDocument();
        expect(screen.queryByTestId("vault-switcher")).not.toBeInTheDocument();
    });
});
