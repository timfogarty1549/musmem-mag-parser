export interface MagParserPayload {
    mag: string;
    pageRange: string;
    title: string;
    author: string;
    year?: number | null;
    month?: number | null;
    volume?: number | null;
    issue?: number | null;
    offset?: number | null;
    exp: number;
}

/**
 * Parses a page range string like "1-5,63-65,70" into a flat array of 1-indexed page numbers.
 * Throws if any segment is malformed or describes a non-positive/decreasing range.
 */
export function parsePageRange(pageRange: string): number[] {
    const pages: number[] = [];

    for (const segment of pageRange.split(',')) {
        const trimmed = segment.trim();
        const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);

        if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10);
            const end = parseInt(rangeMatch[2], 10);
            if (start < 1 || end < start) {
                throw new Error(`Invalid page range segment: "${trimmed}"`);
            }
            for (let p = start; p <= end; p++) pages.push(p);
        } else if (/^\d+$/.test(trimmed)) {
            const page = parseInt(trimmed, 10);
            if (page < 1) {
                throw new Error(`Invalid page range segment: "${trimmed}"`);
            }
            pages.push(page);
        } else {
            throw new Error(`Invalid page range segment: "${trimmed}"`);
        }
    }

    return pages;
}

export interface PageViewerPayload {
    mag: string;
    totalPages: number;
    exp: number;
}

export function isValidPageViewerPayload(payload: unknown): payload is PageViewerPayload {
    if (typeof payload !== 'object' || payload === null) return false;
    const p = payload as Record<string, unknown>;
    if (typeof p.mag !== 'string' || p.mag.trim().length === 0) return false;
    if (typeof p.totalPages !== 'number' || p.totalPages < 1) return false;
    return true;
}

export function isValidPayload(payload: unknown): payload is MagParserPayload {
    if (typeof payload !== 'object' || payload === null) return false;
    const p = payload as Record<string, unknown>;
    if (typeof p.mag !== 'string' || p.mag.trim().length === 0) return false;
    if (typeof p.title !== 'string' || typeof p.author !== 'string') return false;
    if (typeof p.pageRange !== 'string' || p.pageRange.trim().length === 0) return false;

    try {
        if (parsePageRange(p.pageRange).length === 0) return false;
    } catch {
        return false;
    }

    return true;
}
