import { icons as catppuccinIconSetJson } from "@iconify-json/catppuccin";

export type CatppuccinIconName = string;

export const FALLBACK_CATPPUCCIN_ICON = "file";

export interface CatppuccinIconData {
    readonly body: string;
    readonly height?: number;
    readonly left?: number;
    readonly top?: number;
    readonly width?: number;
}

interface CatppuccinIconSet {
    readonly height?: number;
    readonly icons: Record<string, CatppuccinIconData>;
    readonly left?: number;
    readonly top?: number;
    readonly width?: number;
}

const CATPPUCCIN_COLOR_VARIABLES: Record<string, string> = {
    "#3700ff": "--catppuccin-icon-wally-blue",
    "#7dc4e4": "--catppuccin-icon-sapphire",
    "#8087a2": "--catppuccin-icon-overlay1",
    "#8aadf4": "--catppuccin-icon-blue",
    "#8bd5ca": "--catppuccin-icon-teal",
    "#91d7e3": "--catppuccin-icon-sky",
    "#a6da95": "--catppuccin-icon-green",
    "#b7bdf8": "--catppuccin-icon-lavender",
    "#c6a0f6": "--catppuccin-icon-mauve",
    "#cad3f5": "--catppuccin-icon-text",
    "#df8e1d": "--catppuccin-icon-wally-gold",
    "#ed8796": "--catppuccin-icon-red",
    "#ee99a0": "--catppuccin-icon-maroon",
    "#eed49f": "--catppuccin-icon-yellow",
    "#f0c6c6": "--catppuccin-icon-flamingo",
    "#f4dbd6": "--catppuccin-icon-rosewater",
    "#f5a97f": "--catppuccin-icon-peach",
    "#f5bde6": "--catppuccin-icon-pink",
};

const catppuccinIconSet = catppuccinIconSetJson as CatppuccinIconSet;

export function hasCatppuccinIcon(name: CatppuccinIconName): boolean {
    return Object.hasOwn(catppuccinIconSet.icons, name);
}

export function getCatppuccinIcon(
    name: CatppuccinIconName,
): CatppuccinIconData | null {
    return catppuccinIconSet.icons[name] ?? null;
}

export function resolveAvailableCatppuccinIcon(
    name: CatppuccinIconName,
    fallback: CatppuccinIconName = FALLBACK_CATPPUCCIN_ICON,
): CatppuccinIconName {
    if (hasCatppuccinIcon(name)) {
        return name;
    }

    return hasCatppuccinIcon(fallback) ? fallback : FALLBACK_CATPPUCCIN_ICON;
}

export function resolveFirstAvailableCatppuccinIcon(
    names: readonly CatppuccinIconName[],
    fallback: CatppuccinIconName = FALLBACK_CATPPUCCIN_ICON,
): CatppuccinIconName {
    for (const name of names) {
        if (hasCatppuccinIcon(name)) {
            return name;
        }
    }

    return resolveAvailableCatppuccinIcon(fallback);
}

export function getCatppuccinViewBox(icon: CatppuccinIconData): string {
    const left = icon.left ?? catppuccinIconSet.left ?? 0;
    const top = icon.top ?? catppuccinIconSet.top ?? 0;
    const width = icon.width ?? catppuccinIconSet.width ?? 16;
    const height = icon.height ?? catppuccinIconSet.height ?? 16;

    return `${left} ${top} ${width} ${height}`;
}

export function getThemedCatppuccinIconBody(body: string): string {
    return body.replace(/#[0-9a-fA-F]{6}/g, (color) => {
        const variableName = CATPPUCCIN_COLOR_VARIABLES[color.toLowerCase()];
        return variableName ? `var(${variableName})` : color;
    });
}
