import { expect, test } from "@playwright/test";

test("keeps the composer and document when moving, hiding, and archiving", async ({ page }, testInfo) => {
    await page.goto("/chat.html");
    const composer = page.locator('[contenteditable="true"]').first();
    await expect(composer).toBeVisible();
    await composer.fill("A draft to keep");
    await composer.evaluate((element) => {
        (window as unknown as { savedComposer: Element }).savedComposer =
            element;
    });
    await page.getByRole("button", { name: "Chat pane position" }).click();
    await page
        .getByRole("button", { name: "Move to the right", exact: true })
        .click();
    await expect(composer).toHaveText("A draft to keep");
    expect(
        await composer.evaluate(
            (element) =>
                element ===
                (window as unknown as { savedComposer: Element }).savedComposer,
        ),
    ).toBe(true);
    await page.getByRole("button", { name: "Hide chat pane" }).click();
    await expect(composer).toBeHidden();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(composer).toHaveText("A draft to keep");
    await expect(
        page.getByRole("textbox", { name: "Document draft" }),
    ).toHaveValue("Keep this document open while chatting.");
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(
        page.getByRole("button", { name: "Archived (1)" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(composer).toHaveText("A draft to keep");
    await page.screenshot({ path: testInfo.outputPath("chat-pane-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: testInfo.outputPath("chat-pane-dark.png") });
});

test("uses one central surface and list-to-transcript history on narrow windows", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto("/chat.html");
    await expect(
        page.getByRole("textbox", { name: "Document draft" }),
    ).toBeHidden();
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(
        page.getByRole("textbox", { name: "Document draft" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page
        .getByRole("button", { name: "History", exact: true })
        .last()
        .click();
    await expect(page.getByPlaceholder("Search chats…")).toBeVisible();
    await page
        .getByTestId("ai-chat-history-workspace-view")
        .getByText(/Plan the next chapter/)
        .first()
        .click();
    await expect(
        page.getByRole("button", { name: "Back to conversations" }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("chat-pane-narrow.png") });
});
