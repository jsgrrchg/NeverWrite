export type SymbolsIconPath = `files/${string}.svg` | `folders/${string}.svg`;

export interface SymbolsIconData {
    readonly body: string;
    readonly fill?: string;
    readonly isolation?: "isolate";
    readonly source: string;
    readonly viewBox: string;
}

const importedSymbols = import.meta.glob(
    [
        "../../assets/file-icons/files/*.svg",
        "../../assets/file-icons/folders/*.svg",
    ],
    {
        eager: true,
        import: "default",
        query: "?raw",
    },
) as Record<string, string>;

const rawSymbolsByPath = new Map<SymbolsIconPath, string>();
const parsedSymbolsByPath = new Map<SymbolsIconPath, SymbolsIconData>();

const DARK_PALETTE_VARIABLES: ReadonlyArray<
    readonly [original: string, variableName: string]
> = [
    ["#64748B", "--symbols-icon-slate"],
    ["#71717A", "--symbols-icon-zinc"],
    ["#2563EB", "--symbols-icon-blue"],
    ["#EA580C", "--symbols-icon-orange"],
    ["#16A34A", "--symbols-icon-green"],
    ["#8B5CF6", "--symbols-icon-violet"],
    ["#A855F7", "--symbols-icon-purple"],
];

function applyThemePalette(svg: string): string {
    let themedSvg = svg;
    for (const [original, variableName] of DARK_PALETTE_VARIABLES) {
        themedSvg = themedSvg.replaceAll(
            new RegExp(original, "gi"),
            `var(${variableName}, ${original})`,
        );
    }
    return themedSvg;
}

function namespaceSvgIds(svg: string, iconPath: SymbolsIconPath): string {
    const namespace = `symbols-${iconPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const ids = Array.from(svg.matchAll(/\bid=["']([^"']+)["']/g), (match) =>
        match[1],
    ).filter((id): id is string => Boolean(id));

    let namespacedSvg = svg;
    for (const id of ids) {
        const namespacedId = `${namespace}-${id}`;
        namespacedSvg = namespacedSvg
            .replaceAll(`id="${id}"`, `id="${namespacedId}"`)
            .replaceAll(`id='${id}'`, `id='${namespacedId}'`)
            .replaceAll(`url(#${id})`, `url(#${namespacedId})`)
            .replaceAll(`href="#${id}"`, `href="#${namespacedId}"`)
            .replaceAll(`href='#${id}'`, `href='#${namespacedId}'`);
    }
    return namespacedSvg;
}

function attributeValue(attributes: string, attributeName: string) {
    return attributes.match(
        new RegExp(`\\b${attributeName}=["']([^"']+)["']`, "i"),
    )?.[1];
}

function parseSvg(svg: string): SymbolsIconData | null {
    const normalizedSvg = svg
        .trim()
        .replace(/^<\?xml[^>]*>\s*/i, "");
    const match = normalizedSvg.match(
        /^<svg\b([^>]*)>([\s\S]*)<\/svg>$/i,
    );
    if (!match) return null;

    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const style = attributeValue(attributes, "style");
    return {
        body,
        fill: attributeValue(attributes, "fill"),
        isolation: style?.includes("isolation:isolate")
            ? "isolate"
            : undefined,
        source: normalizedSvg,
        viewBox: attributeValue(attributes, "viewBox") ?? "0 0 24 24",
    };
}

for (const [modulePath, svg] of Object.entries(importedSymbols)) {
    const marker = "/file-icons/";
    const markerIndex = modulePath.lastIndexOf(marker);
    if (markerIndex === -1) continue;

    const iconPath = modulePath.slice(markerIndex + marker.length);
    if (iconPath.startsWith("files/") || iconPath.startsWith("folders/")) {
        rawSymbolsByPath.set(iconPath as SymbolsIconPath, svg);
    }
}

export function hasSymbolsIcon(iconPath: string): iconPath is SymbolsIconPath {
    return rawSymbolsByPath.has(iconPath as SymbolsIconPath);
}

export function getSymbolsIconSvg(iconPath: SymbolsIconPath): string | null {
    return getSymbolsIcon(iconPath)?.source ?? null;
}

export function getSymbolsIcon(iconPath: SymbolsIconPath): SymbolsIconData | null {
    const cachedIcon = parsedSymbolsByPath.get(iconPath);
    if (cachedIcon) return cachedIcon;

    const rawSvg = rawSymbolsByPath.get(iconPath);
    if (!rawSvg) return null;

    const themedSvg = applyThemePalette(namespaceSvgIds(rawSvg, iconPath));
    const icon = parseSvg(themedSvg);
    if (icon) parsedSymbolsByPath.set(iconPath, icon);
    return icon;
}
