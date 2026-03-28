/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useVaultStore } from "../../../app/store/vaultStore";
import { mockInvoke } from "../../../test/test-utils";
import {
    getWikilinkSuggestions,
    MAX_WIKILINK_SUGGESTION_CACHE_ENTRIES,
} from "./wikilinkSuggester";

describe("wikilinkSuggester", () => {
    beforeEach(() => {
        useVaultStore.setState((state) => ({
            ...state,
            vaultPath: `/vault-${crypto.randomUUID()}`,
            resolverRevision: state.resolverRevision + 1,
        }));
    });

    it("reuses cached suggestions for the same query", async () => {
        mockInvoke().mockResolvedValue([
            {
                id: "note-1",
                title: "Target",
                subtitle: "/notes/target.md",
                insert_text: "Target",
            },
        ]);

        const first = await getWikilinkSuggestions("note/current", "tar");
        const second = await getWikilinkSuggestions("note/current", "tar");

        expect(first).toEqual(second);
        expect(mockInvoke()).toHaveBeenCalledTimes(1);
    });

    it("evicts the oldest cached query once the limit is exceeded", async () => {
        mockInvoke().mockImplementation(async (_command, payload) => {
            const request = payload as {
                query: string;
            };

            return [
                {
                    id: request.query,
                    title: request.query,
                    subtitle: `/notes/${request.query}.md`,
                    insert_text: request.query,
                },
            ];
        });

        for (
            let index = 0;
            index < MAX_WIKILINK_SUGGESTION_CACHE_ENTRIES + 1;
            index += 1
        ) {
            await getWikilinkSuggestions(
                "note/current",
                `query-${index}`,
                8,
            );
        }

        expect(mockInvoke()).toHaveBeenCalledTimes(
            MAX_WIKILINK_SUGGESTION_CACHE_ENTRIES + 1,
        );

        await getWikilinkSuggestions("note/current", "query-0", 8);

        expect(mockInvoke()).toHaveBeenCalledTimes(
            MAX_WIKILINK_SUGGESTION_CACHE_ENTRIES + 2,
        );
    });
});
