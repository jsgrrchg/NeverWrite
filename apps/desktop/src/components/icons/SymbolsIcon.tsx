import { resolveSymbolsIconPresentation } from "./symbolsIconPresentation";
import type { SymbolsIconPath } from "./symbols-icons";

export function SymbolsIcon({
    className,
    iconPath,
    opacity = 1,
    scaled = false,
    size = 16,
}: {
    readonly className?: string;
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

    return (
        <svg
            aria-hidden="true"
            className={["symbols-icon", className].filter(Boolean).join(" ")}
            fill={icon.fill}
            focusable="false"
            style={{
                display: "block",
                flexShrink: 0,
                height: dimension,
                isolation: icon.isolation,
                opacity,
                width: dimension,
            }}
            viewBox={icon.viewBox}
            xmlns="http://www.w3.org/2000/svg"
            dangerouslySetInnerHTML={{ __html: icon.body }}
        />
    );
}
