/**
 * Server-side lookup of the newest published release, so the dashboard can flag
 * users running a stale tracker.
 *
 * Cached in memory for an hour and shared by every dashboard viewer: GitHub
 * allows 60 unauthenticated requests/hour/IP, and a busy dashboard with SSE
 * refreshes would burn through that in minutes. A failed lookup is cached too
 * (briefly), so an outage doesn't turn into a request storm.
 */

import { LATEST_RELEASE_API, RELEASES_PAGE, CLIENT_VERSION } from '../shared/version.ts';

const OK_TTL_MS = 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;

export interface LatestVersion {
    latest: string | null;
    checkedAt: string;
    releasesPage: string;
    error?: string;
}

let cache: { value: LatestVersion; expiresAt: number } | null = null;
/** Shared across concurrent callers so a cache miss makes one request, not N. */
let inFlight: Promise<LatestVersion> | null = null;

async function lookup(): Promise<LatestVersion> {
    const checkedAt = new Date().toISOString();
    try {
        const res = await fetch(LATEST_RELEASE_API, {
            headers: {
                accept: 'application/vnd.github+json',
                'user-agent': `llm-usage-tracker-server/${CLIENT_VERSION}`
            },
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) {
            return { latest: null, checkedAt, releasesPage: RELEASES_PAGE, error: `GitHub returned ${res.status}` };
        }
        const body = (await res.json()) as { tag_name?: string };
        const tag = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/i, '') : '';
        return tag
            ? { latest: tag, checkedAt, releasesPage: RELEASES_PAGE }
            : { latest: null, checkedAt, releasesPage: RELEASES_PAGE, error: 'release has no tag' };
    } catch {
        return { latest: null, checkedAt, releasesPage: RELEASES_PAGE, error: 'lookup failed' };
    }
}

export async function latestVersion(): Promise<LatestVersion> {
    if (cache && cache.expiresAt > Date.now()) return cache.value;
    if (inFlight) return inFlight;

    inFlight = lookup()
        .then((value) => {
            cache = { value, expiresAt: Date.now() + (value.latest ? OK_TTL_MS : FAIL_TTL_MS) };
            return value;
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}
