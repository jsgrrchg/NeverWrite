import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STAGED_NATIVE_BACKEND_DIR = path.join(__dirname, "out", "native-backend");
const MAC_ADDITIONAL_BINARY_MAGIC_NUMBERS = new Set([
    0xfeedface,
    0xcefaedfe,
    0xfeedfacf,
    0xcffaedfe,
    0xcafebabe,
    0xbebafeca,
    0xcafebabf,
    0xbfbafeca,
]);
const DEFAULT_MAC_BINARY_RELATIVE_PATHS = [
    "neverwrite-native-backend",
    "binaries/codex-acp",
    "embedded/node/bin/node",
];

const outputDir =
    process.env.NEVERWRITE_ELECTRON_OUTPUT_DIR?.trim() || "dist-electron";

function toPosixPath(value) {
    return value.split(path.sep).join(path.posix.sep);
}

function walkFiles(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const absolutePath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkFiles(absolutePath));
            continue;
        }

        if (entry.isFile()) {
            files.push(absolutePath);
        }
    }

    return files;
}

function isMachOBinary(filePath) {
    const descriptor = fs.openSync(filePath, "r");
    try {
        const header = Buffer.alloc(4);
        const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
        if (bytesRead < 4) {
            return false;
        }

        return MAC_ADDITIONAL_BINARY_MAGIC_NUMBERS.has(header.readUInt32BE(0));
    } finally {
        fs.closeSync(descriptor);
    }
}

function isMacAdditionalBinaryFile(filePath, relativePath) {
    const normalizedRelativePath = toPosixPath(relativePath);
    const lowerCasePath = normalizedRelativePath.toLowerCase();

    if (
        lowerCasePath.includes("/node_modules/.bin/") ||
        lowerCasePath.endsWith(".js") ||
        lowerCasePath.endsWith(".cjs") ||
        lowerCasePath.endsWith(".mjs") ||
        lowerCasePath.endsWith(".json") ||
        lowerCasePath.endsWith(".md") ||
        lowerCasePath.endsWith(".map") ||
        lowerCasePath.endsWith(".ts") ||
        lowerCasePath.endsWith(".d.ts")
    ) {
        return false;
    }

    if (
        lowerCasePath.endsWith(".dylib") ||
        lowerCasePath.endsWith(".node") ||
        lowerCasePath.endsWith(".so")
    ) {
        return true;
    }

    return isMachOBinary(filePath);
}

function collectMacAdditionalBinaries(nativeBackendDir) {
    const packagedPrefix = path.posix.join(
        "Contents",
        "Resources",
        "native-backend",
    );
    const collectedPaths = new Set(
        DEFAULT_MAC_BINARY_RELATIVE_PATHS.map((relativePath) =>
            path.posix.join(packagedPrefix, relativePath),
        ),
    );

    for (const absolutePath of walkFiles(nativeBackendDir)) {
        const relativePath = path.relative(nativeBackendDir, absolutePath);
        if (!relativePath) {
            continue;
        }

        if (!isMacAdditionalBinaryFile(absolutePath, relativePath)) {
            continue;
        }

        collectedPaths.add(
            path.posix.join(packagedPrefix, toPosixPath(relativePath)),
        );
    }

    return [...collectedPaths].sort();
}

const macAdditionalBinaries = collectMacAdditionalBinaries(
    STAGED_NATIVE_BACKEND_DIR,
);

export default {
    appId: process.env.NEVERWRITE_ELECTRON_APP_ID?.trim() || "com.neverwrite",
    productName: "NeverWrite",
    executableName: "NeverWrite",
    asar: true,
    directories: {
        output: outputDir,
        buildResources: "build",
    },
    artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
    files: ["out/electron/**/*", "package.json"],
    extraResources: [
        {
            from: "out/native-backend",
            to: "native-backend",
            filter: ["**/*"],
        },
        {
            from: "build/icons",
            to: "icons",
            filter: ["icon.ico", "icon.png"],
        },
    ],
    protocols: [
        {
            name: "NeverWrite",
            schemes: ["neverwrite"],
        },
    ],
    publish: [
        {
            provider: "generic",
            url: "https://updates.neverwrite.invalid/feed",
        },
    ],
    afterPack: path.join(__dirname, "scripts", "verify-electron-bundle.mjs"),
    mac: {
        category: "public.app-category.productivity",
        icon: path.join("build", "icons", "icon.icns"),
        minimumSystemVersion: "12.0",
        hardenedRuntime: true,
        gatekeeperAssess: false,
        entitlements: path.join("build", "entitlements.mac.plist"),
        entitlementsInherit: path.join(
            "build",
            "entitlements.mac.inherit.plist",
        ),
        binaries: macAdditionalBinaries,
        x64ArchFiles: [
            "Contents/Resources/native-backend/**/*",
            "Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/canvas-darwin-arm64/**/*",
            "Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/canvas-darwin-x64/**/*",
        ],
        target: ["dmg", "zip"],
    },
    dmg: {
        sign: false,
    },
    win: {
        icon: path.join("build", "icons", "icon.ico"),
        verifyUpdateCodeSignature: false,
        // Electron Builder's Windows rcedit path can try to unpack a full
        // winCodeSign archive with Darwin symlinks, which fails on Windows
        // hosts without symlink privileges. The afterPack hook stamps the exe
        // with the local rcedit package instead.
        signAndEditExecutable: false,
        target: ["nsis"],
    },
    nsis: {
        oneClick: false,
        perMachine: false,
        shortcutName: "NeverWrite",
        allowElevation: true,
        allowToChangeInstallationDirectory: false,
        differentialPackage: true,
        installerIcon: path.join("build", "icons", "icon.ico"),
        uninstallerIcon: path.join("build", "icons", "icon.ico"),
        installerHeaderIcon: path.join("build", "icons", "icon.ico"),
        deleteAppDataOnUninstall: false,
    },
};
