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

export function CatppuccinIcon({
    className,
    iconName,
    opacity = 1,
    scaled = false,
    size = 16,
}: {
    readonly className?: string;
    readonly iconName: CatppuccinIconName;
    readonly opacity?: number;
    readonly scaled?: boolean;
    readonly size?: number | string;
}) {
    const resolvedIconName = resolveAvailableCatppuccinIcon(
        iconName,
        FALLBACK_CATPPUCCIN_ICON,
    );
    const icon = getCatppuccinIcon(resolvedIconName);

    if (!icon) {
        return null;
    }

    const dim =
        typeof size === "number"
            ? scaled
                ? scaleIconSize(size)
                : `${size}px`
            : size;

    return (
        <svg
            aria-hidden="true"
            className={className}
            focusable="false"
            height={dim}
            style={{ display: "block", flexShrink: 0, opacity }}
            viewBox={getCatppuccinViewBox(icon)}
            width={dim}
            xmlns="http://www.w3.org/2000/svg"
            dangerouslySetInnerHTML={{
                __html: getThemedCatppuccinIconBody(icon.body),
            }}
        />
    );
}
