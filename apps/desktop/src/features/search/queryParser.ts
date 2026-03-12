export type Operator = "file" | "path" | "tag" | "content" | "line" | "section" | "property";

const OPERATORS: ReadonlySet<string> = new Set<Operator>([
    "file",
    "path",
    "tag",
    "content",
    "line",
    "section",
]);

export interface SearchToken {
    value: string;
    operator?: Operator;
    /** For property operator: the frontmatter key (e.g. "status" in [status:active]) */
    propertyKey?: string;
    negated: boolean;
    isRegex: boolean;
    /** For OR groups: tokens combined with OR */
    orGroup?: SearchToken[];
}

export interface ParsedQuery {
    tokens: SearchToken[];
    raw: string;
    needsContentSearch: boolean;
    explanation: string;
}

/** Tokenize a raw query string into SearchTokens with operator/negation/regex detection. */
export function parseQuery(raw: string): ParsedQuery {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { tokens: [], raw, needsContentSearch: false, explanation: "" };
    }

    const rawTokens = tokenize(trimmed);
    const tokens = resolveOrGroups(rawTokens);

    const needsContentSearch = tokens.some(
        (t) =>
            t.operator === "content" ||
            t.operator === "line" ||
            t.operator === "section" ||
            (t.orGroup?.some(
                (g) =>
                    g.operator === "content" ||
                    g.operator === "line" ||
                    g.operator === "section",
            ) ??
                false),
    );

    return {
        tokens,
        raw,
        needsContentSearch,
        explanation: buildExplanation(tokens),
    };
}

// ── Tokenizer ──────────────────────────────────────────

function tokenize(input: string): SearchToken[] {
    const tokens: SearchToken[] = [];
    let i = 0;

    while (i < input.length) {
        // Skip whitespace
        if (input[i] === " ") {
            i++;
            continue;
        }

        // Check for OR keyword (must be surrounded by spaces or at boundaries)
        if (
            input.substring(i, i + 2) === "OR" &&
            (i + 2 >= input.length || input[i + 2] === " ") &&
            (i === 0 || input[i - 1] === " ")
        ) {
            tokens.push({
                value: "OR",
                negated: false,
                isRegex: false,
            });
            i += 2;
            continue;
        }

        // Check negation prefix
        let negated = false;
        if (input[i] === "-" && i + 1 < input.length && input[i + 1] !== " ") {
            negated = true;
            i++;
        }

        // Check for [property:value] syntax
        if (input[i] === "[") {
            const end = input.indexOf("]", i + 1);
            if (end !== -1) {
                const inner = input.substring(i + 1, end);
                const colonIdx = inner.indexOf(":");
                if (colonIdx > 0) {
                    const key = inner.substring(0, colonIdx).trim();
                    const val = inner.substring(colonIdx + 1).trim();
                    if (key && val) {
                        tokens.push({
                            value: val,
                            operator: "property",
                            propertyKey: key,
                            negated,
                            isRegex: false,
                        });
                        i = end + 1;
                        continue;
                    }
                }
            }
        }

        // Check for operator prefix (e.g., "tag:", "content:")
        let operator: Operator | undefined;
        for (const op of OPERATORS) {
            if (
                input.substring(i, i + op.length + 1) === `${op}:` &&
                i + op.length + 1 < input.length
            ) {
                operator = op as Operator;
                i += op.length + 1;
                break;
            }
        }

        // Extract value
        let value: string;
        let isRegex = false;

        if (input[i] === '"') {
            // Quoted string
            const end = input.indexOf('"', i + 1);
            if (end === -1) {
                value = input.substring(i + 1);
                i = input.length;
            } else {
                value = input.substring(i + 1, end);
                i = end + 1;
            }
        } else if (input[i] === "/" && !operator) {
            // Regex pattern
            const end = input.indexOf("/", i + 1);
            if (end !== -1) {
                value = input.substring(i + 1, end);
                isRegex = true;
                i = end + 1;
            } else {
                value = input.substring(i + 1);
                i = input.length;
            }
        } else if (input[i] === "(") {
            // Parenthesized group — extract contents and recursively tokenize
            let depth = 1;
            let j = i + 1;
            while (j < input.length && depth > 0) {
                if (input[j] === "(") depth++;
                else if (input[j] === ")") depth--;
                j++;
            }
            const inner = input.substring(i + 1, j - 1);
            i = j;

            // Recursively tokenize the inner content
            const innerTokens = tokenize(inner);
            const resolved = resolveOrGroups(innerTokens);

            // If it's a single OR group, apply the operator/negation to the group
            if (resolved.length === 1 && resolved[0].orGroup) {
                const group = resolved[0];
                if (operator) {
                    for (const t of group.orGroup!) {
                        if (!t.operator) t.operator = operator;
                    }
                }
                if (negated) group.negated = true;
                tokens.push(group);
            } else {
                // Multiple terms in parens — treat as sub-tokens
                for (const t of resolved) {
                    if (operator && !t.operator) t.operator = operator;
                    if (negated) t.negated = !t.negated;
                    tokens.push(t);
                }
            }
            continue;
        } else {
            // Plain word
            const end = input.indexOf(" ", i);
            if (end === -1) {
                value = input.substring(i);
                i = input.length;
            } else {
                value = input.substring(i, end);
                i = end;
            }
        }

        if (value) {
            tokens.push({ value, operator, negated, isRegex });
        }
    }

    return tokens;
}

// ── OR Group Resolution ────────────────────────────────

function resolveOrGroups(tokens: SearchToken[]): SearchToken[] {
    const result: SearchToken[] = [];
    let i = 0;

    while (i < tokens.length) {
        if (
            i + 2 < tokens.length &&
            tokens[i + 1].value === "OR" &&
            !tokens[i + 1].operator
        ) {
            // Collect all OR-chained tokens
            const group: SearchToken[] = [tokens[i]];
            while (
                i + 2 < tokens.length &&
                tokens[i + 1].value === "OR" &&
                !tokens[i + 1].operator
            ) {
                group.push(tokens[i + 2]);
                i += 2;
            }
            result.push({
                value: group.map((t) => t.value).join(" OR "),
                negated: false,
                isRegex: false,
                orGroup: group,
            });
            i++;
        } else if (tokens[i].value === "OR" && !tokens[i].operator) {
            // Stray OR — skip
            i++;
        } else {
            result.push(tokens[i]);
            i++;
        }
    }

    return result;
}

// ── Explanation Builder ────────────────────────────────

function buildExplanation(tokens: SearchToken[]): string {
    if (tokens.length === 0) return "";

    const parts: string[] = [];

    for (const token of tokens) {
        if (token.orGroup) {
            const sub = token.orGroup
                .map((t) => describeToken(t))
                .join(" or ");
            parts.push(`(${sub})`);
        } else {
            parts.push(describeToken(token));
        }
    }

    return parts.join(", ");
}

function describeToken(token: SearchToken): string {
    const neg = token.negated ? "excluding " : "";
    const val = token.isRegex ? `/${token.value}/` : `"${token.value}"`;

    switch (token.operator) {
        case "file":
            return `${neg}filename matching ${val}`;
        case "path":
            return `${neg}path matching ${val}`;
        case "tag":
            return `${neg}tag ${val}`;
        case "content":
            return `${neg}content matching ${val}`;
        case "line":
            return `${neg}line containing ${val}`;
        case "section":
            return `${neg}section containing ${val}`;
        case "property":
            return `${neg}property [${token.propertyKey}:${token.value}]`;
        default:
            return `${neg}title/path matching ${val}`;
    }
}
