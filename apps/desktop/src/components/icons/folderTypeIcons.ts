import symbolsManifestJson from "../../assets/file-icons/file-icons.json";
import {
    hasSymbolsIcon,
    type SymbolsIconPath,
} from "./symbols-icons";

export interface ResolvedFolderTypeIcon {
    readonly iconPath: SymbolsIconPath;
}

interface SymbolsManifest {
    readonly folder?: string;
    readonly folderNames?: Readonly<Record<string, string>>;
    readonly iconDefinitions: Readonly<
        Record<string, { readonly iconPath: string }>
    >;
}

const manifest = symbolsManifestJson as SymbolsManifest;
const folderNames = new Map(
    Object.entries(manifest.folderNames ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
    ]),
);

function normalizeFolderName(folderName: string): string {
    const normalizedPath = folderName.replaceAll("\\", "/");
    return (normalizedPath.split("/").at(-1) ?? folderName).toLowerCase();
}

function definitionIconPath(definitionName: string): SymbolsIconPath | null {
    const manifestPath = manifest.iconDefinitions[
        definitionName
    ]?.iconPath.replace(/^\.\/icons\//, "");
    return manifestPath && hasSymbolsIcon(manifestPath) ? manifestPath : null;
}

export function resolveSymbolsFolderIcon(
    folderName: string,
    _open: boolean,
): ResolvedFolderTypeIcon {
    const normalizedFolderName = normalizeFolderName(folderName);
    const definitionName =
        folderNames.get(normalizedFolderName) ?? manifest.folder ?? "folder";

    return {
        // Symbols uses the disclosure chevron for expanded state; Zeron also
        // intentionally renders the same folder artwork open and closed.
        iconPath:
            definitionIconPath(definitionName) ?? "folders/folder.svg",
    };
}

export const resolveFolderTypeIcon = resolveSymbolsFolderIcon;
