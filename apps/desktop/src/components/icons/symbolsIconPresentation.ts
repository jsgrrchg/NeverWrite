import {
    getSymbolsIcon,
    type SymbolsIconPath,
} from "./symbols-icons";

function scaleIconSize(value: number): string {
    return `calc(${value}px * var(--file-tree-scale, 1))`;
}

export function resolveSymbolsIconPresentation(
    iconPath: SymbolsIconPath,
    size: number | string,
    scaled: boolean,
) {
    const icon = getSymbolsIcon(iconPath);
    const dimension =
        typeof size === "number"
            ? scaled
                ? scaleIconSize(size)
                : `${size}px`
            : size;

    return { dimension, icon };
}

/** Creates the same bundled Symbols icon for imperative contenteditable surfaces. */
export function createSymbolsIconElement({
    iconPath,
    opacity = 1,
    scaled = false,
    size = 16,
}: {
    readonly iconPath: SymbolsIconPath;
    readonly opacity?: number;
    readonly scaled?: boolean;
    readonly size?: number | string;
}) {
    const { dimension, icon } = resolveSymbolsIconPresentation(
        iconPath,
        size,
        scaled,
    );
    if (!icon) return null;

    const template = document.createElement("template");
    template.innerHTML = icon.source;
    const element = template.content.firstElementChild;
    if (!(element instanceof SVGSVGElement)) return null;

    element.setAttribute("aria-hidden", "true");
    element.setAttribute("class", "symbols-icon");
    element.removeAttribute("height");
    element.removeAttribute("width");
    element.style.display = "block";
    element.style.flexShrink = "0";
    element.style.height = dimension;
    element.style.opacity = String(opacity);
    element.style.width = dimension;
    return element;
}
