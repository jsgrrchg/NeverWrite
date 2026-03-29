import { describe, expect, it } from "vitest";
import { getClaudeGatewayUrlValidationMessage } from "./claudeGatewayUrl";

describe("getClaudeGatewayUrlValidationMessage", () => {
    it("allows HTTPS gateways", () => {
        expect(
            getClaudeGatewayUrlValidationMessage("https://gateway.example/v1"),
        ).toBeNull();
    });

    it("allows loopback HTTP gateways", () => {
        expect(
            getClaudeGatewayUrlValidationMessage("http://localhost:3000"),
        ).toBeNull();
        expect(
            getClaudeGatewayUrlValidationMessage("http://api.localhost:3000"),
        ).toBeNull();
        expect(
            getClaudeGatewayUrlValidationMessage("http://127.0.0.1:3000"),
        ).toBeNull();
    });

    it("rejects remote HTTP gateways", () => {
        expect(
            getClaudeGatewayUrlValidationMessage("http://gateway.example"),
        ).toBe("HTTP gateways are only allowed for localhost.");
    });

    it("rejects embedded credentials", () => {
        expect(
            getClaudeGatewayUrlValidationMessage(
                "https://user:pass@gateway.example",
            ),
        ).toBe("Gateway URL must not include embedded credentials.");
    });
});
