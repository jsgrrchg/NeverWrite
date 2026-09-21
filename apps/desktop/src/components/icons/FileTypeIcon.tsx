import { SymbolsIcon } from "./SymbolsIcon";
import {
    resolveSymbolsFileIcon,
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
    const { iconPath } = resolveSymbolsFileIcon(fileName, {
        kind,
        mimeType,
    });

    return (
        <SymbolsIcon
            className={className}
            iconPath={iconPath}
            opacity={opacity}
            scaled={scaled}
            size={size}
        />
    );
}
