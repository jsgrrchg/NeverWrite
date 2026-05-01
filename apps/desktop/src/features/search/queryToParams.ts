import { type ParsedQuery, type SearchToken } from "./queryParser";

interface SearchTermParam {
    value: string;
    negated: boolean;
    is_regex: boolean;
}

interface ContentSearchParam {
    value: string;
    scope: string;
    negated: boolean;
    is_regex: boolean;
}

interface PropertyFilterParam {
    key: string;
    value: string;
    negated: boolean;
    is_regex: boolean;
}

export interface AdvancedSearchParams {
    terms: SearchTermParam[];
    tag_filters: SearchTermParam[];
    file_filters: SearchTermParam[];
    path_filters: SearchTermParam[];
    content_searches: ContentSearchParam[];
    property_filters: PropertyFilterParam[];
    sort_by: string;
    sort_asc: boolean;
    prefer_file_name: boolean;
}

interface AdvancedSearchOptions {
    preferFileName?: boolean;
}

export function toAdvancedSearchParams(
    parsed: ParsedQuery,
    sortBy = "relevance",
    sortAsc = false,
    options: AdvancedSearchOptions = {},
): AdvancedSearchParams {
    const params: AdvancedSearchParams = {
        terms: [],
        tag_filters: [],
        file_filters: [],
        path_filters: [],
        content_searches: [],
        property_filters: [],
        sort_by: sortBy,
        sort_asc: sortAsc,
        prefer_file_name: options.preferFileName ?? false,
    };

    for (const token of parsed.tokens) {
        if (token.orGroup) {
            for (const member of token.orGroup) {
                addToken(params, member);
            }
        } else {
            addToken(params, token);
        }
    }

    return params;
}

function addToken(params: AdvancedSearchParams, token: SearchToken): void {
    const term: SearchTermParam = {
        value: token.value,
        negated: token.negated,
        is_regex: token.isRegex,
    };

    switch (token.operator) {
        case "tag":
            params.tag_filters.push(term);
            break;
        case "file":
            params.file_filters.push(term);
            break;
        case "path":
            params.path_filters.push(term);
            break;
        case "content":
            params.content_searches.push({ ...term, scope: "content" });
            break;
        case "line":
            params.content_searches.push({ ...term, scope: "line" });
            break;
        case "section":
            params.content_searches.push({ ...term, scope: "section" });
            break;
        case "property":
            params.property_filters.push({
                key: token.propertyKey ?? "",
                value: token.value,
                negated: token.negated,
                is_regex: token.isRegex,
            });
            break;
        default:
            params.terms.push(term);
            break;
    }
}
