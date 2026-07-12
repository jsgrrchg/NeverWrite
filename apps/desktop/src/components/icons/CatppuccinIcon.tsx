import {
    getCatppuccinViewBox,
    getThemedCatppuccinIconBody,
    type CatppuccinIconName,
} from "./catppuccin-icons";
import { resolveCatppuccinIconPresentation } from "./catppuccinIconPresentation";

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
    const { dimension, icon } = resolveCatppuccinIconPresentation(
        iconName,
        size,
        scaled,
    );

    if (!icon) {
        return null;
    }

    return (
        <svg
            aria-hidden="true"
            className={className}
            focusable="false"
            height={dimension}
            style={{ display: "block", flexShrink: 0, opacity }}
            viewBox={getCatppuccinViewBox(icon)}
            width={dimension}
            xmlns="http://www.w3.org/2000/svg"
            dangerouslySetInnerHTML={{
                __html: getThemedCatppuccinIconBody(icon.body),
            }}
        />
    );
}
