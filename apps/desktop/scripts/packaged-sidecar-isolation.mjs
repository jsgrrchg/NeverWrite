import fs from "node:fs/promises";

export async function isolateExecutableForSmoke(
    sourcePath,
    destinationPath,
    { fileSystem = fs, platform = process.platform } = {},
) {
    let isolationMethod;
    try {
        await fileSystem.link(sourcePath, destinationPath);
        isolationMethod = "hard-link";
    } catch {
        await fileSystem.copyFile(sourcePath, destinationPath);
        isolationMethod = "copy";
    }

    // A hard link shares the packaged inode, so chmod would mutate the release asset.
    if (platform !== "win32" && isolationMethod === "copy") {
        await fileSystem.chmod(destinationPath, 0o755);
    }

    return isolationMethod;
}
