export async function writeClipboardText(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
}
