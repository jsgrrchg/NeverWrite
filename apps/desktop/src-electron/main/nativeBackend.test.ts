import { describe, expect, it } from "vitest";
import {
    DEVELOPMENT_SECRET_SERVICE,
    RELEASE_SECRET_SERVICE,
} from "./appIdentity";
import { buildNativeBackendProfileEnvironment } from "./nativeBackend";

describe("buildNativeBackendProfileEnvironment", () => {
    it("keeps the canonical release app data and keyring namespace", () => {
        expect(
            buildNativeBackendProfileEnvironment({
                appDataDir: "/profiles/NeverWrite",
                runtimeSecretServiceName: RELEASE_SECRET_SERVICE,
            }),
        ).toEqual({
            NEVERWRITE_APP_DATA_DIR: "/profiles/NeverWrite",
            NEVERWRITE_AI_SECRET_SERVICE: RELEASE_SECRET_SERVICE,
        });
    });

    it("gives development separate app data and keyring namespaces", () => {
        expect(
            buildNativeBackendProfileEnvironment({
                appDataDir: "/profiles/NeverWrite Dev",
                runtimeSecretServiceName: DEVELOPMENT_SECRET_SERVICE,
            }),
        ).toEqual({
            NEVERWRITE_APP_DATA_DIR: "/profiles/NeverWrite Dev",
            NEVERWRITE_AI_SECRET_SERVICE: DEVELOPMENT_SECRET_SERVICE,
        });
    });

    it("rejects an empty keyring namespace", () => {
        expect(() =>
            buildNativeBackendProfileEnvironment({
                appDataDir: "/profiles/NeverWrite Dev",
                runtimeSecretServiceName: "   ",
            }),
        ).toThrow("Native backend secret service name is required.");
    });
});
