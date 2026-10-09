import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildVaultPreviewUrlFromAbsolutePath } from "../src/app/utils/filePreviewUrl";
import { toVaultRelativePath } from "../src/app/utils/vaultPaths";

// Only Electron's host APIs are mocked. The preview handler, filesystem,
// frontend URL builder, Rust canonicalization and PDF.js are real.
vi.mock("electron", () => ({
    app: { isPackaged: true },
    BrowserWindow: {},
    dialog: {},
    ipcMain: {},
    shell: {},
}));

import { registerPreviewProtocolHandler } from "../src-electron/main/ipc";

let scratch: string;
let canonicalizer: string;

function createPdf() {
    const stream = "0 0 1 rg\n10 10 30 30 re f\n";
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>",
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) {
        pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
}

beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "neverwrite-pdf-519-"));
    const source = path.join(scratch, "canonicalize.rs");
    canonicalizer = path.join(
        scratch,
        process.platform === "win32" ? "canonicalize.exe" : "canonicalize",
    );
    // Same operations as the native backend: canonicalize the vault root,
    // then return a discovered file's absolute path under that root.
    await fs.writeFile(source, `
fn main() -> std::io::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let root = std::fs::canonicalize(args.next().expect("vault path"))?;
    let file = root.join(args.next().expect("relative file path"));
    println!("{}", root.display());
    println!("{}", file.display());
    Ok(())
}
`);
    execFileSync("rustc", ["--edition=2021", source, "-o", canonicalizer], {
        timeout: 45_000,
        stdio: "pipe",
    });
});

afterAll(async () => {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
});

it.each(["Local Vault", "OneDrive/Universidad José/My Vault"])(
    "loads a PDF through real Rust paths and the preview handler: %s",
    async (directory) => {
        // A local directory with OneDrive-like naming, not a live cloud mount.
        const vault = path.join(scratch, directory);
        const relativePath = "docs/Asymptoter.pdf";
        const bytes = createPdf();
        await fs.mkdir(path.join(vault, "docs"), { recursive: true });
        await fs.writeFile(path.join(vault, relativePath), bytes);

        const [canonicalVault, canonicalFile] = execFileSync(
            canonicalizer,
            [vault, relativePath],
            { encoding: "utf8", timeout: 10_000 },
        ).trimEnd().split(/\r?\n/);
        expect(toVaultRelativePath(canonicalFile, canonicalVault)).toBe(relativePath);

        if (process.platform === "win32") {
            expect(canonicalVault.startsWith("\\\\?\\")).toBe(true);
            // Demonstrate the old failure on paths produced by Windows itself.
            const oldPathname = canonicalFile.split(/[?#]/, 1)[0];
            expect(toVaultRelativePath(oldPathname, canonicalVault)).toBeNull();
        }

        const previewUrl = buildVaultPreviewUrlFromAbsolutePath(
            canonicalFile,
            canonicalVault,
        );
        console.info(JSON.stringify({
            platform: process.platform,
            canonicalVault,
            canonicalFile,
            previewUrl,
        }));
        expect(previewUrl).not.toBeNull();
        const handler = registerPreviewProtocolHandler({ invoke: vi.fn() } as never);
        const response = await handler(new Request(previewUrl!));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/pdf");
        const data = new Uint8Array(await response.arrayBuffer());
        expect(Buffer.from(data)).toEqual(bytes);

        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const loadingTask = pdfjs.getDocument({
            data,
            isImageDecoderSupported: false,
            isOffscreenCanvasSupported: false,
            stopAtErrors: true,
            useSystemFonts: true,
            verbosity: pdfjs.VerbosityLevel.ERRORS,
        });
        try {
            const pdf = await loadingTask.promise;
            expect(pdf.numPages).toBe(1);
            const page = await pdf.getPage(1);
            const operators = await page.getOperatorList();
            expect(operators.fnArray.length).toBeGreaterThan(0);
        } finally {
            await loadingTask.destroy();
        }
    },
);
