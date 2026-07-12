import type {
    AIChatFileSummary,
    AIChatNoteSummary,
    AIMentionSuggestion,
} from "./types";

const FETCH_KEYWORDS = ["fetch", "web", "search", "buscar", "internet"];

function normalizeForSearch(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function getNoteFileNameForSearch(note: AIChatNoteSummary) {
    return note.path.split("/").pop() ?? note.path;
}

function getNoteMentionLabel(
    note: AIChatNoteSummary,
    showExtensions: boolean,
    preferFileName: boolean,
) {
    if (!preferFileName) return note.title;

    const fileName = getNoteFileNameForSearch(note);
    return showExtensions ? fileName : fileName.replace(/\.md$/i, "");
}

function getFileMentionLabel(file: AIChatFileSummary, showExtensions: boolean) {
    return showExtensions ? file.fileName : file.title || file.fileName;
}

function getFuzzySearchScore(query: string, candidate: string) {
    let queryIndex = 0;
    let lastMatchIndex = -1;
    let gaps = 0;

    for (let index = 0; index < candidate.length; index += 1) {
        if (candidate[index] !== query[queryIndex]) continue;
        if (lastMatchIndex >= 0) gaps += index - lastMatchIndex - 1;
        lastMatchIndex = index;
        queryIndex += 1;
        if (queryIndex === query.length) return gaps + lastMatchIndex;
    }

    return null;
}

function getMentionSearchScore(
    query: string,
    primaryValues: string[],
    secondaryValue: string,
) {
    if (!query) return 0;

    const normalizedPrimary = primaryValues.map(normalizeForSearch);
    const normalizedSecondary = normalizeForSearch(secondaryValue);
    const segmentStart = (value: string) =>
        value.split(/[\\/._\-\s]+/).some((segment) => segment.startsWith(query));

    if (normalizedPrimary.some((value) => value === query)) return 0;
    if (normalizedPrimary.some((value) => value.startsWith(query))) return 10;
    if (normalizedPrimary.some(segmentStart)) return 20;
    if (normalizedPrimary.some((value) => value.includes(query))) return 30;
    if (normalizedSecondary.startsWith(query)) return 40;
    if (segmentStart(normalizedSecondary)) return 50;
    if (normalizedSecondary.includes(query)) return 60;

    const primaryFuzzyScores = normalizedPrimary
        .map((value) => getFuzzySearchScore(query, value))
        .filter((score): score is number => score !== null);
    if (primaryFuzzyScores.length > 0) {
        return 100 + Math.min(...primaryFuzzyScores);
    }

    const secondaryFuzzyScore = getFuzzySearchScore(query, normalizedSecondary);
    return secondaryFuzzyScore === null ? null : 200 + secondaryFuzzyScore;
}

interface RankedMentionSuggestion {
    item: AIMentionSuggestion;
    label: string;
    rank: number;
    secondary: string;
    typeRank: number;
}

export function getMentionSuggestions(
    notes: AIChatNoteSummary[],
    files: AIChatFileSummary[],
    folderPaths: string[],
    query: string,
    includeFiles: boolean,
    preferFileName: boolean,
    showExtensions: boolean,
    limit = 10,
): AIMentionSuggestion[] {
    const normalizedQuery = normalizeForSearch(query);
    const results: AIMentionSuggestion[] = [];

    if (
        !normalizedQuery ||
        FETCH_KEYWORDS.some(
            (keyword) => keyword.startsWith(normalizedQuery),
        )
    ) {
        results.push({ kind: "fetch" });
    }

    const candidates: RankedMentionSuggestion[] = [];
    for (const folderPath of folderPaths) {
        const name = folderPath.split("/").pop() ?? folderPath;
        const rank = getMentionSearchScore(
            normalizedQuery,
            [name],
            folderPath,
        );
        if (rank === null) continue;
        candidates.push({
            item: { kind: "folder", folderPath, name },
            label: name,
            rank,
            secondary: folderPath,
            typeRank: 0,
        });
    }

    for (const note of notes) {
        const label = getNoteMentionLabel(note, showExtensions, preferFileName);
        const rank = getMentionSearchScore(
            normalizedQuery,
            preferFileName
                ? [getNoteFileNameForSearch(note), note.title]
                : [note.title, getNoteFileNameForSearch(note)],
            note.path,
        );
        if (rank === null) continue;
        candidates.push({
            item: { kind: "note", note, label },
            label,
            rank,
            secondary: note.path,
            typeRank: 1,
        });
    }

    if (includeFiles) {
        for (const file of files) {
            const label = getFileMentionLabel(file, showExtensions);
            const rank = getMentionSearchScore(
                normalizedQuery,
                [file.fileName, file.title],
                file.relativePath,
            );
            if (rank === null) continue;
            candidates.push({
                item: { kind: "file", file, label },
                label,
                rank,
                secondary: file.relativePath,
                typeRank: 2,
            });
        }
    }

    candidates.sort(
        (left, right) =>
            left.rank - right.rank ||
            left.typeRank - right.typeRank ||
            left.label.localeCompare(right.label) ||
            left.secondary.localeCompare(right.secondary),
    );

    return [...results, ...candidates.map(({ item }) => item)].slice(0, limit);
}
