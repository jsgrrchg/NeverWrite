import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocationBreadcrumb } from "./LocationBreadcrumb";
import { getCompactLocationSegments } from "./locationBreadcrumbUtils";

describe("getCompactLocationSegments", () => {
    it("keeps short routes intact", () => {
        expect(getCompactLocationSegments(["Notes", "Daily"])).toEqual([
            "Notes",
            "Daily",
        ]);
    });

    it("preserves the root and immediate parent when compacting a deep route", () => {
        expect(
            getCompactLocationSegments([
                "Análisis",
                "Agosto 2026",
                "Ficha diaria",
                "Semana 2026-08-03 a 2026-08-09",
            ]),
        ).toEqual(["Análisis", "…", "Semana 2026-08-03 a 2026-08-09"]);
    });
});

describe("LocationBreadcrumb", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps the full path in a native tooltip and truncates to one line", () => {
        const fullPath =
            "Análisis / Agosto 2026 / Ficha diaria / Semana 2026-08-03 a 2026-08-09";

        render(
            <LocationBreadcrumb
                segments={[
                    "Análisis",
                    "Agosto 2026",
                    "Ficha diaria",
                    "Semana 2026-08-03 a 2026-08-09",
                ]}
            />,
        );

        const breadcrumb = screen.getByTitle(fullPath);
        expect(breadcrumb).toHaveStyle({ overflow: "hidden" });
        expect(breadcrumb.firstElementChild).toHaveStyle({
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
        });
    });

    it("collapses intermediate folders when the available width is too small", () => {
        let resizeCallback: ResizeObserverCallback | null = null;
        const originalResizeObserver = globalThis.ResizeObserver;

        class MockResizeObserver {
            constructor(callback: ResizeObserverCallback) {
                resizeCallback = callback;
            }

            observe() {}

            disconnect() {}
        }

        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            value: MockResizeObserver,
        });

        try {
            const { container } = render(
                <div data-breadcrumb-container="true">
                    <LocationBreadcrumb
                        segments={[
                            "Análisis",
                            "Agosto 2026",
                            "Ficha diaria",
                            "Semana 2026-08-03 a 2026-08-09",
                        ]}
                    />
                </div>,
            );

            const parent = container.querySelector(
                '[data-breadcrumb-container="true"]',
            )!;
            const measurement = container.querySelector(
                '[aria-hidden="true"]',
            )!;
            Object.defineProperty(parent, "clientWidth", {
                configurable: true,
                value: 200,
            });
            Object.defineProperty(measurement, "offsetWidth", {
                configurable: true,
                value: 600,
            });

            act(() => {
                resizeCallback?.([], {} as ResizeObserver);
            });

            expect(
                screen.getByText(
                    "Análisis / … / Semana 2026-08-03 a 2026-08-09",
                ),
            ).toBeInTheDocument();
        } finally {
            Object.defineProperty(globalThis, "ResizeObserver", {
                configurable: true,
                value: originalResizeObserver,
            });
        }
    });
});
