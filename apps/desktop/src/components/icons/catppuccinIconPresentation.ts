import {
    FALLBACK_CATPPUCCIN_ICON,
    getCatppuccinIcon,
    getCatppuccinViewBox,
    getThemedCatppuccinIconBody,
    resolveAvailableCatppuccinIcon,
    type CatppuccinIconName,
} from "./catppuccin-icons";

function scaleIconSize(value: number): string {
    return `calc(${value}px * var(--file-tree-scale, 1))`;
}

export function resolveCatppuccinIconPresentation(
    iconName: CatppuccinIconName,
    size: number | string,
    scaled: boolean,
) {
    const resolvedIconName = resolveAvailableCatppuccinIcon(
        iconName,
        FALLBACK_CATPPUCCIN_ICON,
    );
    const icon = getCatppuccinIcon(resolvedIconName);
    const dimension =
        typeof size === "number"
            ? scaled
                ? scaleIconSize(size)
                : `${size}px`
            : size;

    return { dimension, icon };
}

/** Creates the same icon SVG for imperative contenteditable surfaces. */
export function createCatppuccinIconElement({
    iconName,
    opacity = 1,
    scaled = false,
    size = 16,
}: {
    readonly iconName: CatppuccinIconName;
    readonly opacity?: number;
    readonly scaled?: boolean;
    readonly size?: number | string;
}) {
    const { dimension, icon } = resolveCatppuccinIconPresentation(
        iconName,
        size,
        scaled,
    );
    if (!icon) return null;

    const element = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
    );
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("focusable", "false");
    element.setAttribute("height", dimension);
    element.setAttribute("viewBox", getCatppuccinViewBox(icon));
    element.setAttribute("width", dimension);
    element.style.display = "block";
    element.style.flexShrink = "0";
    element.style.opacity = String(opacity);
    element.innerHTML = getThemedCatppuccinIconBody(icon.body);
    return element;
}
