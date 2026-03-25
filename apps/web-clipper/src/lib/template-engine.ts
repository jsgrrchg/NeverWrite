import type { ClipData } from "./clipper-contract";
import type { ClipperTemplate } from "./types";

export interface ClipTemplateContext {
    clipData: ClipData;
    title: string;
    tags: string[];
    folder: string;
    content: string;
}

export interface ResolvedClipTemplate {
    id: string | null;
    name: string;
    body: string;
}

const TEMPLATE_VARIABLES = [
    "title",
    "url",
    "domain",
    "content",
    "description",
    "author",
    "published",
    "image",
    "favicon",
    "language",
    "tags",
    "folder",
    "date",
    "time",
    "datetime",
] as const;

export function listTemplateVariables(): string[] {
    return [...TEMPLATE_VARIABLES];
}

function scoreTemplateMatch(
    template: ClipperTemplate,
    vaultId: string,
    domain: string,
): number {
    const normalizedDomain = domain.trim().toLowerCase();
    const templateDomain = template.domain.trim().toLowerCase();
    const matchesVault = !template.vaultId || template.vaultId === vaultId;
    const matchesDomain =
        !templateDomain ||
        templateDomain === normalizedDomain ||
        normalizedDomain.endsWith(`.${templateDomain}`);

    if (!matchesVault || !matchesDomain) {
        return -1;
    }

    let score = 0;
    if (template.vaultId) {
        score += 2;
    }
    if (templateDomain) {
        score += 3;
    }
    return score;
}

export function resolveClipTemplate(options: {
    templates: ClipperTemplate[];
    defaultTemplate: string;
    vaultId: string;
    domain: string;
}): ResolvedClipTemplate {
    let bestTemplate: ClipperTemplate | null = null;
    let bestScore = -1;

    for (const template of options.templates) {
        const score = scoreTemplateMatch(
            template,
            options.vaultId,
            options.domain,
        );
        if (score > bestScore) {
            bestTemplate = template;
            bestScore = score;
        }
    }

    if (bestTemplate) {
        return {
            id: bestTemplate.id,
            name: bestTemplate.name,
            body: bestTemplate.body,
        };
    }

    return {
        id: null,
        name: "Default template",
        body: options.defaultTemplate,
    };
}

export function renderClipTemplate(
    templateBody: string,
    context: ClipTemplateContext,
): string {
    const now = new Date();
    const tags = context.tags.join(", ");
    const values: Record<string, string> = {
        title: context.title || context.clipData.metadata.title,
        url: context.clipData.metadata.url,
        domain: context.clipData.metadata.domain,
        content: context.content,
        description: context.clipData.metadata.description || "",
        author: context.clipData.metadata.author || "",
        published: context.clipData.metadata.published || "",
        image: context.clipData.metadata.image || "",
        favicon: context.clipData.metadata.favicon || "",
        language: context.clipData.metadata.language || "",
        tags,
        folder: context.folder,
        date: now.toISOString().slice(0, 10),
        time: now.toISOString().slice(11, 19),
        datetime: now.toISOString(),
    };

    return templateBody.replaceAll(
        /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
        (match, variableName: string) => values[variableName] ?? match,
    );
}
