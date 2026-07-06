import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { invoke } from "@neverwrite/runtime";
import {
    MarkdownNoteHeader,
    type MarkdownNoteHeaderProps,
} from "./MarkdownNoteHeader";
import { resetSystemUsernameCacheForTests } from "../okf/systemUsername";
import { useVaultStore } from "../../app/store/vaultStore";

function renderWith(overrides: Partial<MarkdownNoteHeaderProps> = {}) {
    const props: MarkdownNoteHeaderProps = {
        editableTitle: "Example note",
        lineWrapping: true,
        onTitleChange: () => {},
        titleInputRef: { current: null },
        locationParent: "Notes",
        frontmatterRaw: null,
        onFrontmatterChange: vi.fn(),
        propertiesExpanded: false,
        onToggleProperties: vi.fn(),
        onSearchClick: vi.fn(),
        ...overrides,
    };
    render(<MarkdownNoteHeader {...props} />);
    return props;
}

function renderHeader(lineWrapping: boolean) {
    render(
        <MarkdownNoteHeader
            editableTitle="Example note"
            lineWrapping={lineWrapping}
            onTitleChange={() => {}}
            titleInputRef={{ current: null }}
            locationParent="Notes"
            frontmatterRaw={null}
            onFrontmatterChange={() => {}}
            propertiesExpanded={false}
            onToggleProperties={vi.fn()}
            onSearchClick={vi.fn()}
        />,
    );

    return {
        outer: document.querySelector(
            '[data-editor-note-header="true"]',
        ) as HTMLElement | null,
        inner: document.querySelector(
            '[data-editor-note-header-inner="true"]',
        ) as HTMLElement | null,
    };
}

describe("MarkdownNoteHeader", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps the centered reading layout when line wrapping is enabled", () => {
        const { outer, inner } = renderHeader(true);
        expect(outer).not.toBeNull();
        expect(inner).not.toBeNull();
        expect(outer).toHaveAttribute("data-line-wrapping", "true");
        expect(outer).toHaveStyle({
            width: "100%",
            padding: "40px var(--editor-horizontal-inset) 0",
        });
        expect(inner).toHaveStyle({
            width: "min(100%, var(--editor-content-width))",
            maxWidth: "var(--editor-content-width)",
            margin: "0 auto",
            minWidth: "0",
        });
        expect(screen.getByDisplayValue("Example note")).toBeInTheDocument();
    });

    it("switches to a left-aligned layout when line wrapping is disabled", () => {
        const { outer, inner } = renderHeader(false);
        expect(outer).not.toBeNull();
        expect(inner).not.toBeNull();
        expect(outer).toHaveAttribute("data-line-wrapping", "false");
        expect(outer).toHaveStyle({
            width: "100%",
            padding: "40px var(--editor-horizontal-inset) 0",
        });
        expect(inner).toHaveStyle({
            width: "100%",
            maxWidth: "none",
            margin: "0px",
            minWidth: "0",
        });
    });

    it("allows the secondary toolbar actions to wrap instead of collapsing the header width", () => {
        renderHeader(true);

        const propertiesButton = screen.getByRole("button", {
            name: "Properties",
        });
        const toolbar = propertiesButton.parentElement;

        expect(toolbar).not.toBeNull();
        expect(toolbar).toHaveStyle({
            display: "flex",
            flexWrap: "wrap",
            minWidth: "0",
        });
    });

    it("recalculates the title height when the available width changes", async () => {
        let resizeCallback: ResizeObserverCallback | null = null;
        const originalResizeObserver = globalThis.ResizeObserver;
        const originalFonts = document.fonts;
        const originalScrollHeight = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "scrollHeight",
        );
        let currentScrollHeight = 78;

        class MockResizeObserver {
            constructor(callback: ResizeObserverCallback) {
                resizeCallback = callback;
            }

            observe() {}
            unobserve() {}
            disconnect() {}
        }

        try {
            Object.defineProperty(globalThis, "ResizeObserver", {
                configurable: true,
                writable: true,
                value: MockResizeObserver,
            });
            Object.defineProperty(document, "fonts", {
                configurable: true,
                value: {
                    ready: Promise.resolve(),
                },
            });
            Object.defineProperty(
                HTMLTextAreaElement.prototype,
                "scrollHeight",
                {
                    configurable: true,
                    get: () => currentScrollHeight,
                },
            );

            renderHeader(true);

            const titleInput = screen.getByDisplayValue(
                "Example note",
            ) as HTMLTextAreaElement;

            await waitFor(() => {
                expect(titleInput.style.height).toBe("78px");
            });

            currentScrollHeight = 42;

            await act(async () => {
                resizeCallback?.(
                    [
                        {
                            contentRect: {
                                width: 640,
                                height: 0,
                                x: 0,
                                y: 0,
                                top: 0,
                                right: 640,
                                bottom: 0,
                                left: 0,
                                toJSON: () => ({}),
                            },
                        } as ResizeObserverEntry,
                    ],
                    {} as ResizeObserver,
                );
                await new Promise((resolve) => setTimeout(resolve, 0));
            });

            expect(titleInput.style.height).toBe("42px");
        } finally {
            Object.defineProperty(globalThis, "ResizeObserver", {
                configurable: true,
                writable: true,
                value: originalResizeObserver,
            });
            Object.defineProperty(document, "fonts", {
                configurable: true,
                value: originalFonts,
            });
            if (originalScrollHeight) {
                Object.defineProperty(
                    HTMLTextAreaElement.prototype,
                    "scrollHeight",
                    originalScrollHeight,
                );
            } else {
                delete (
                    HTMLTextAreaElement.prototype as unknown as Record<
                        string,
                        unknown
                    >
                ).scrollHeight;
            }
        }
    });
});

const fm = (body: string) => `---\n${body}\n---\n`;

describe("MarkdownNoteHeader — OKF status", () => {
    // Earlier tests in this file leave `document.fonts` defined-but-undefined,
    // which makes EditableNoteTitle's `document.fonts.ready` throw. Ensure a
    // usable stub so these renders don't crash on that unrelated effect.
    beforeEach(() => {
        Object.defineProperty(document, "fonts", {
            configurable: true,
            value: { ready: Promise.resolve() },
        });
        // The system username is cached module-wide; isolate tests. The
        // global setup resets the `invoke` mock, so unless a test provides
        // one, the username resolves to null (no `status_by` written).
        resetSystemUsernameCacheForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders a status badge for each canonical status", () => {
        const cases: Array<[string, string]> = [
            ["draft", "Draft"],
            ["in_review", "In review"],
            ["published", "Published"],
            ["deprecated", "Deprecated"],
            ["archived", "Archived"],
        ];
        for (const [raw, label] of cases) {
            const { unmount } = render(
                <MarkdownNoteHeader
                    editableTitle="Example note"
                    lineWrapping
                    onTitleChange={() => {}}
                    titleInputRef={{ current: null }}
                    locationParent="Notes"
                    frontmatterRaw={fm(`status: ${raw}`)}
                    onFrontmatterChange={vi.fn()}
                    propertiesExpanded={false}
                    onToggleProperties={vi.fn()}
                    onSearchClick={vi.fn()}
                />,
            );
            expect(
                screen.getByRole("button", { name: label }),
            ).toBeInTheDocument();
            unmount();
        }
    });

    it("shows a subtle 'Set status' affordance and no banner when status is absent", () => {
        renderWith({ frontmatterRaw: null });
        expect(
            screen.getByRole("button", { name: "Set status" }),
        ).toBeInTheDocument();
        expect(document.querySelector("[data-status-banner]")).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Draft" }),
        ).not.toBeInTheDocument();
    });

    it("renders a type badge showing the raw type value", () => {
        renderWith({ frontmatterRaw: fm("type: runbook") });
        expect(screen.getByText("runbook")).toBeInTheDocument();
    });

    it.each([
        ["draft", "Draft — this document has not been published."],
        ["in_review", "In review — content may change before publication."],
        ["deprecated", "Deprecated — this document is outdated."],
        ["archived", "Archived — kept for reference only."],
    ])("renders the trust banner for %s", (raw, copy) => {
        renderWith({ frontmatterRaw: fm(`status: ${raw}`) });
        const banner = document.querySelector("[data-status-banner]");
        expect(banner).not.toBeNull();
        expect(banner).toHaveTextContent(copy);
    });

    it("renders no banner for published", () => {
        renderWith({ frontmatterRaw: fm("status: published") });
        expect(document.querySelector("[data-status-banner]")).toBeNull();
    });

    it("shows an unknown status verbatim with no banner", () => {
        renderWith({ frontmatterRaw: fm("status: needs work") });
        expect(
            screen.getByRole("button", { name: "needs work" }),
        ).toBeInTheDocument();
        expect(document.querySelector("[data-status-banner]")).toBeNull();
    });

    it("updates the status via the dropdown while preserving other keys and order", async () => {
        const props = renderWith({
            frontmatterRaw: fm("title: Hello\nstatus: draft\ntype: note"),
        });

        fireEvent.click(screen.getByRole("button", { name: "Draft" }));
        fireEvent.click(screen.getByRole("button", { name: "Published" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("title: Hello");
        expect(next).toContain("status: published");
        expect(next).toContain("type: note");
        // Order preserved: title before status before type.
        expect(next.indexOf("title")).toBeLessThan(next.indexOf("status"));
        expect(next.indexOf("status")).toBeLessThan(next.indexOf("type"));
    });

    it("removes the status key when 'No status' is chosen", async () => {
        const props = renderWith({
            frontmatterRaw: fm("title: Hello\nstatus: draft"),
        });

        fireEvent.click(screen.getByRole("button", { name: "Draft" }));
        fireEvent.click(screen.getByRole("button", { name: "No status" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("title: Hello");
        expect(next).not.toContain("status:");
    });

    it("adds a status when none exists via 'Set status'", async () => {
        const props = renderWith({ frontmatterRaw: fm("title: Hello") });

        fireEvent.click(screen.getByRole("button", { name: "Set status" }));
        fireEvent.click(screen.getByRole("button", { name: "In review" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("title: Hello");
        expect(next).toContain("status: in_review");
    });

    it("seeds the new frontmatter block with the note title when created from scratch", async () => {
        const props = renderWith({
            editableTitle: "Example note",
            frontmatterRaw: null,
        });

        fireEvent.click(screen.getByRole("button", { name: "Set status" }));
        fireEvent.click(screen.getByRole("button", { name: "Draft" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("title: Example note");
        expect(next).toContain("status: draft");
        // Title first, then status.
        expect(next.indexOf("title:")).toBeLessThan(next.indexOf("status:"));
    });

    it("does not inject a title into existing frontmatter that lacks one", async () => {
        const props = renderWith({
            editableTitle: "Example note",
            frontmatterRaw: fm("type: note"),
        });

        fireEvent.click(screen.getByRole("button", { name: "Set status" }));
        fireEvent.click(screen.getByRole("button", { name: "Draft" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("type: note");
        expect(next).toContain("status: draft");
        expect(next).not.toContain("title:");
    });

    it("records status_by with the system username on status change", async () => {
        vi.mocked(invoke).mockResolvedValue("simon");
        const props = renderWith({
            frontmatterRaw: fm("title: Hello\nstatus: draft\ntype: note"),
        });

        fireEvent.click(screen.getByRole("button", { name: "Draft" }));
        fireEvent.click(screen.getByRole("button", { name: "Published" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        expect(invoke).toHaveBeenCalledWith("get_system_username");
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("status: published");
        expect(next).toContain("status_by: simon");
        expect(next).toContain("type: note");
        // status_by sits directly after status, before the other keys.
        expect(next.indexOf("status:")).toBeLessThan(
            next.indexOf("status_by:"),
        );
        expect(next.indexOf("status_by:")).toBeLessThan(
            next.indexOf("type:"),
        );
    });

    it("creates frontmatter from scratch as title, status, status_by", async () => {
        vi.mocked(invoke).mockResolvedValue("simon");
        const props = renderWith({
            editableTitle: "Example note",
            frontmatterRaw: null,
        });

        fireEvent.click(screen.getByRole("button", { name: "Set status" }));
        fireEvent.click(screen.getByRole("button", { name: "Draft" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("title: Example note");
        expect(next).toContain("status: draft");
        expect(next).toContain("status_by: simon");
        expect(next.indexOf("title:")).toBeLessThan(next.indexOf("status:"));
        expect(next.indexOf("status:")).toBeLessThan(
            next.indexOf("status_by:"),
        );
    });

    it("removes status_by along with status when 'No status' is chosen", async () => {
        const props = renderWith({
            frontmatterRaw: fm("title: Hello\nstatus: draft\nstatus_by: bob"),
        });

        fireEvent.click(screen.getByRole("button", { name: "Draft" }));
        fireEvent.click(screen.getByRole("button", { name: "No status" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("title: Hello");
        expect(next).not.toContain("status:");
        expect(next).not.toContain("status_by:");
    });

    it("omits status_by when the username is unavailable", async () => {
        vi.mocked(invoke).mockResolvedValue(null);
        const props = renderWith({
            frontmatterRaw: fm("title: Hello"),
        });

        fireEvent.click(screen.getByRole("button", { name: "Set status" }));
        fireEvent.click(screen.getByRole("button", { name: "Draft" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("status: draft");
        expect(next).not.toContain("status_by:");
    });

    it("preserves the title across two consecutive status changes with live prop flow", async () => {
        vi.mocked(invoke).mockResolvedValue("simon");
        const changes: Array<string | null> = [];

        // Model Editor.tsx's real delivery: applyFrontmatterChange calls
        // setActiveFrontmatter(nextRaw), which re-renders the header with the
        // new frontmatterRaw prop.
        function Harness() {
            const [raw, setRaw] = useState<string | null>(null);
            return (
                <MarkdownNoteHeader
                    editableTitle="Example note"
                    lineWrapping
                    onTitleChange={() => {}}
                    titleInputRef={{ current: null }}
                    locationParent="Notes"
                    frontmatterRaw={raw}
                    onFrontmatterChange={(next) => {
                        changes.push(next);
                        setRaw(next);
                    }}
                    propertiesExpanded={false}
                    onToggleProperties={vi.fn()}
                    onSearchClick={vi.fn()}
                />
            );
        }
        render(<Harness />);

        // First change: create frontmatter from scratch.
        fireEvent.click(screen.getByRole("button", { name: "Set status" }));
        fireEvent.click(screen.getByRole("button", { name: "Draft" }));
        await waitFor(() => expect(changes).toHaveLength(1));
        expect(changes[0]).toContain("title: Example note");
        expect(changes[0]).toContain("status: draft");
        expect(changes[0]).toContain("status_by: simon");

        // Second change: badge now shows Draft; switch to Published.
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Draft" }),
            ).toBeInTheDocument(),
        );
        fireEvent.click(screen.getByRole("button", { name: "Draft" }));
        fireEvent.click(screen.getByRole("button", { name: "Published" }));
        await waitFor(() => expect(changes).toHaveLength(2));

        expect(changes[1]).toContain("title: Example note");
        expect(changes[1]).toContain("status: published");
        expect(changes[1]).toContain("status_by: simon");
    });

    it("preserves an existing title when only the status changes", async () => {
        vi.mocked(invoke).mockResolvedValue("simon");
        const props = renderWith({
            frontmatterRaw: fm("title: My Runbook\nstatus: draft"),
        });

        fireEvent.click(screen.getByRole("button", { name: "Draft" }));
        fireEvent.click(screen.getByRole("button", { name: "Archived" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("title: My Runbook");
        expect(next).toContain("status: archived");
    });

    it("builds the change from the freshest frontmatter when the raw updates mid-await", async () => {
        // Regression: the username fetch awaits an IPC round-trip. If a newer
        // frontmatter raw lands during that await (save response, external
        // sync), the write must be computed from the fresh raw, not from the
        // entries captured at click time - otherwise keys that only exist in
        // the fresh raw (like a just-added title) are silently dropped.
        let resolveUsername: (value: string) => void = () => {};
        vi.mocked(invoke).mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveUsername = resolve as (value: string) => void;
                }),
        );

        const onFrontmatterChange = vi.fn();
        const baseProps: MarkdownNoteHeaderProps = {
            editableTitle: "Example note",
            lineWrapping: true,
            onTitleChange: () => {},
            titleInputRef: { current: null },
            locationParent: "Notes",
            frontmatterRaw: fm("status: draft\nstatus_by: simon"),
            onFrontmatterChange,
            propertiesExpanded: false,
            onToggleProperties: vi.fn(),
            onSearchClick: vi.fn(),
        };
        const { rerender } = render(<MarkdownNoteHeader {...baseProps} />);

        // Click Published; setStatus is now parked on the username fetch.
        fireEvent.click(screen.getByRole("button", { name: "Draft" }));
        fireEvent.click(screen.getByRole("button", { name: "Published" }));
        // Flush the queued menu action so setStatus starts and the fetch is
        // actually pending.
        await act(async () => {});
        expect(invoke).toHaveBeenCalledWith("get_system_username");

        // A newer raw (title added elsewhere) arrives while the fetch is
        // pending.
        rerender(
            <MarkdownNoteHeader
                {...baseProps}
                frontmatterRaw={fm(
                    "title: My Runbook\nstatus: draft\nstatus_by: simon",
                )}
            />,
        );

        await act(async () => {
            resolveUsername("simon");
            await Promise.resolve();
        });

        await waitFor(() => expect(onFrontmatterChange).toHaveBeenCalled());
        const next = onFrontmatterChange.mock.calls[0][0] as string;
        expect(next).toContain("title: My Runbook");
        expect(next).toContain("status: published");
        expect(next).toContain("status_by: simon");
    });

    it("does not crash and omits status_by when the username fetch fails", async () => {
        vi.mocked(invoke).mockRejectedValue(new Error("ipc unavailable"));
        const props = renderWith({
            frontmatterRaw: fm("title: Hello"),
        });

        fireEvent.click(screen.getByRole("button", { name: "Set status" }));
        fireEvent.click(screen.getByRole("button", { name: "Draft" }));

        await waitFor(() =>
            expect(props.onFrontmatterChange).toHaveBeenCalled(),
        );
        const next = (props.onFrontmatterChange as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(next).toContain("status: draft");
        expect(next).not.toContain("status_by:");
    });
});

describe("MarkdownNoteHeader — OKF conformance hint", () => {
    beforeEach(() => {
        Object.defineProperty(document, "fonts", {
            configurable: true,
            value: { ready: Promise.resolve() },
        });
    });

    afterEach(() => {
        useVaultStore.setState({ okfVersion: null });
        vi.restoreAllMocks();
    });

    it("shows the hint when the vault is OKF and the note has no type", () => {
        useVaultStore.setState({ okfVersion: "0.1.0" });
        renderWith({ frontmatterRaw: fm("title: Hello") });
        expect(
            screen.getByRole("button", { name: "No OKF type" }),
        ).toBeInTheDocument();
    });

    it("hides the hint when the note already has a type", () => {
        useVaultStore.setState({ okfVersion: "0.1.0" });
        renderWith({ frontmatterRaw: fm("type: runbook") });
        expect(
            screen.queryByRole("button", { name: "No OKF type" }),
        ).not.toBeInTheDocument();
    });

    it("hides the hint when the vault is not an OKF vault", () => {
        useVaultStore.setState({ okfVersion: null });
        renderWith({ frontmatterRaw: fm("title: Hello") });
        expect(
            screen.queryByRole("button", { name: "No OKF type" }),
        ).not.toBeInTheDocument();
    });

    it("opens the Properties panel when the hint is clicked", () => {
        useVaultStore.setState({ okfVersion: "0.1.0" });
        const props = renderWith({
            frontmatterRaw: fm("title: Hello"),
            propertiesExpanded: false,
        });
        fireEvent.click(screen.getByRole("button", { name: "No OKF type" }));
        expect(props.onToggleProperties).toHaveBeenCalledTimes(1);
    });
});
