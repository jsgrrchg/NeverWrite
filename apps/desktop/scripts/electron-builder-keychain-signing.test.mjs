import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const appBuilderLibRoot = path.join(
    desktopRoot,
    "node_modules/app-builder-lib",
);

test("electron-builder uses the temporary keychain password for macOS signing", async () => {
    const source = await fs.readFile(
        path.join(appBuilderLibRoot, "out/codeSign/macCodeSign.js"),
        "utf8",
    );

    // Official fix from electron-builder#10172, tracked by NeverWrite#438.
    assert.match(
        source,
        /importCerts\(keychainFile, certPaths, cscPasswords, keychainPassword\)/,
    );
    assert.match(
        source,
        /async function importCerts\(keychainFile, paths, keyPasswords, keychainPassword\)/,
    );
    assert.match(
        source,
        /\["import", paths\[i\], "-k", keychainFile, "-T", "\/usr\/bin\/codesign", "-T", "\/usr\/bin\/productbuild", "-P", password\]/,
    );
    assert.match(
        source,
        /\["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile\]/,
    );
    assert.doesNotMatch(
        source,
        /\["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile\]/,
    );
});
