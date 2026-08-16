/**
 * Client version, reported with every ingest event so the dashboard can show
 * who's on a stale build. Single source of truth — `lut version` prints it,
 * `macos-app/build.sh` stamps it into the app's Info.plist, and the release tag
 * should match. Bump this and tag `v<CLIENT_VERSION>`; nothing else to edit.
 *
 * Also home to the release-lookup constants and the version comparison the
 * update checker uses, so the CLI, the Mac app and the server all agree on what
 * "newer" means. Zero-dependency (see AGENTS.md) — plain string maths only.
 */
export const CLIENT_VERSION = '1.7.0';

/** GitHub repo the update checker pulls releases from. */
export const RELEASES_REPO = 'versantus/llm-usage-tracker';

/** Latest-release endpoint. Unauthenticated: 60 req/hour/IP, hence the cache. */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

/** Human-facing releases page, for "see what changed" links. */
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;

/**
 * Numeric components of a version, tolerating a leading `v` and any
 * `-prerelease` / `+build` suffix. Non-numeric junk parses as 0 rather than
 * NaN, so a malformed tag sorts low instead of poisoning the comparison.
 */
export function parseVersion(version: string): number[] {
    return String(version)
        .trim()
        .replace(/^v/i, '')
        .split(/[-+]/)[0]
        .split('.')
        .map((part) => {
            const n = Number.parseInt(part, 10);
            return Number.isFinite(n) ? n : 0;
        });
}

/** Standard comparator: -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a: string, b: string): number {
    const left = parseVersion(a);
    const right = parseVersion(b);
    const len = Math.max(left.length, right.length);
    for (let i = 0; i < len; i++) {
        const l = left[i] ?? 0;
        const r = right[i] ?? 0;
        if (l !== r) return l < r ? -1 : 1;
    }
    return 0;
}

/** Whether `candidate` is a strictly newer release than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
    return compareVersions(candidate, current) > 0;
}
