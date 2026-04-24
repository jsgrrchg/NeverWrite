import { CatppuccinIcon } from "./CatppuccinIcon";
import {
    resolveCatppuccinFileIcon,
    type FileTypeIconKind,
} from "./fileTypeIcons";

export function FileTypeIcon({
    className,
    fileName,
    kind,
    mimeType,
    opacity = 0.86,
    scaled = false,
    size = 13,
}: {
    readonly className?: string;
    readonly fileName: string;
    readonly kind?: FileTypeIconKind;
    readonly mimeType?: string | null;
    readonly opacity?: number;
    readonly scaled?: boolean;
    readonly size?: number | string;
}) {
    const { iconName } = resolveCatppuccinFileIcon(fileName, {
        kind,
        mimeType,
    });

    return (
        <CatppuccinIcon
            className={className}
            iconName={iconName}
            opacity={opacity}
            scaled={scaled}
            size={size}
        />
    );
}
