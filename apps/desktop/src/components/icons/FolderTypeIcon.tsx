import { CatppuccinIcon } from "./CatppuccinIcon";
import { resolveCatppuccinFolderIcon } from "./folderTypeIcons";

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
    const { iconName } = resolveCatppuccinFolderIcon(folderName, open);

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
