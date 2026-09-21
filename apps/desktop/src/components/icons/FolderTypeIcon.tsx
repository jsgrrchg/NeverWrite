import { SymbolsIcon } from "./SymbolsIcon";
import { resolveSymbolsFolderIcon } from "./folderTypeIcons";

export function FolderTypeIcon({
    className,
    folderName,
    opacity = 0.86,
    open,
    scaled = false,
    size = 15,
}: {
    readonly className?: string;
    readonly folderName: string;
    readonly opacity?: number;
    readonly open: boolean;
    readonly scaled?: boolean;
    readonly size?: number | string;
}) {
    const { iconPath } = resolveSymbolsFolderIcon(folderName, open);

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
