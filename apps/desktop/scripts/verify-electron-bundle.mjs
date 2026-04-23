import fs from "node:fs";
import path from "node:path";

const REQUIRED_RESOURCE_PATHS = {
    darwin: [
        "native-backend/neverwrite-native-backend",
        "native-backend/binaries/codex-acp",
        "native-backend/embedded/node/bin/node",
        "native-backend/embedded/claude-agent-acp/dist/index.js",
    ],
    win32: [
        "native-backend/neverwrite-native-backend.exe",
        "native-backend/binaries/codex-acp.exe",
        "native-backend/embedded/node/bin/node.exe",
        "native-backend/embedded/claude-agent-acp/dist/index.js",
    ],
};

function resolveResourcesDir(packContext) {
    if (packContext.electronPlatformName === "darwin") {
        const appBundleName = fs
            .readdirSync(packContext.appOutDir, { withFileTypes: true })
            .find((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
            ?.name;
        if (!appBundleName) {
            throw new Error(
                `Could not locate the packaged .app bundle in ${packContext.appOutDir}.`,
            );
        }

        return path.join(
            packContext.appOutDir,
            appBundleName,
            "Contents",
            "Resources",
        );
    }

    if (packContext.electronPlatformName === "win32") {
        return path.join(packContext.appOutDir, "resources");
    }

    throw new Error(
        `Unsupported electron platform for bundle verification: ${packContext.electronPlatformName}`,
    );
}

function assertExecutableMode(absolutePath) {
    if (process.platform === "win32") {
        return;
    }

    const mode = fs.statSync(absolutePath).mode;
    if ((mode & 0o111) === 0) {
        throw new Error(`Packaged binary is not executable: ${absolutePath}`);
    }
}

export default async function verifyElectronBundle(packContext) {
    const resourcesDir = resolveResourcesDir(packContext);
    const requiredPaths = REQUIRED_RESOURCE_PATHS[packContext.electronPlatformName];

    if (!requiredPaths) {
        throw new Error(
            `No resource verification manifest is defined for ${packContext.electronPlatformName}.`,
        );
    }

    for (const relativePath of requiredPaths) {
        const absolutePath = path.join(resourcesDir, relativePath);
        if (!fs.existsSync(absolutePath)) {
            throw new Error(
                `Packaged bundle is missing required resource: ${absolutePath}`,
            );
        }

        if (
            relativePath.endsWith("neverwrite-native-backend") ||
            relativePath.endsWith("neverwrite-native-backend.exe") ||
            relativePath.endsWith("/codex-acp") ||
            relativePath.endsWith("/codex-acp.exe") ||
            relativePath.endsWith("/node") ||
            relativePath.endsWith("/node.exe")
        ) {
            assertExecutableMode(absolutePath);
        }
    }
}
