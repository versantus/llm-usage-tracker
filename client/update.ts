/**
 * Update checker + self-updater for the `lut` binary.
 *
 * Checks the GitHub releases API for a newer tag than CLIENT_VERSION and, on
 * request, swaps the running binary for the matching release asset. The check
 * is cached for a day (unauthenticated GitHub allows 60 requests/hour/IP, and
 * five watchers plus the Mac app would otherwise all hit it independently), so
 * background callers can ask as often as they like.
 *
 * POLICY: checking is automatic, installing never is. `checkForUpdate()` only
 * reads; `applyUpdate()` is reached solely from an explicit `lut update` or a
 * button press. An update rewrites LaunchAgents and re-signs the binary, which
 * can make macOS re-prompt for permissions — not something to do behind
 * someone's back while they're mid-session.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
    CLIENT_VERSION,
    LATEST_RELEASE_API,
    RELEASES_PAGE,
    isNewerVersion
} from '../shared/version.ts';
import { configDir } from './config.ts';
import { restartService } from './watcher-service.ts';

/** How long a release lookup stays fresh. "Check daily" lives here. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateStatus {
    current: string;
    /** Latest published version, or null when the lookup failed. */
    latest: string | null;
    updateAvailable: boolean;
    /** Download URL for this platform's asset, when one is published. */
    assetUrl: string | null;
    /** ISO timestamp of the lookup this came from (may be a cache hit). */
    checkedAt: string;
    /** Whether the answer came from cache rather than the network. */
    cached: boolean;
    releasesPage: string;
    /** Populated instead of `latest` when the lookup failed. */
    error?: string;
}

/** Release asset name for the host platform, matching scripts/build-cli.sh. */
export function assetNameForHost(): string {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    if (process.platform === 'darwin') return `lut-darwin-${arch}`;
    if (process.platform === 'win32') return `lut-windows-${arch}.exe`;
    return `lut-linux-${arch}`;
}

/**
 * Whether this process can replace itself. Under `bun run cli/lut.ts` the
 * "binary" is bun itself — overwriting that would be catastrophic.
 */
export function isCompiledBinary(): boolean {
    const exe = basename(process.execPath).toLowerCase();
    return !/^bun(\.exe)?$/.test(exe) && !exe.startsWith('node');
}

function cachePath(): string {
    return join(configDir(), 'update-check.json');
}

interface CacheFile {
    checkedAt: string;
    latest: string | null;
    assetUrl: string | null;
    error?: string;
}

function readCache(): CacheFile | null {
    try {
        const raw = JSON.parse(readFileSync(cachePath(), 'utf-8')) as CacheFile;
        if (typeof raw?.checkedAt !== 'string') return null;
        const age = Date.now() - Date.parse(raw.checkedAt);
        if (!Number.isFinite(age) || age < 0 || age > CACHE_TTL_MS) return null;
        return raw;
    } catch {
        return null;
    }
}

function writeCache(entry: CacheFile): void {
    try {
        mkdirSync(configDir(), { recursive: true });
        writeFileSync(cachePath(), JSON.stringify(entry));
    } catch {
        // best effort — a missing cache just means we ask GitHub again
    }
}

function statusFrom(entry: CacheFile, cached: boolean): UpdateStatus {
    return {
        current: CLIENT_VERSION,
        latest: entry.latest,
        updateAvailable: !!entry.latest && isNewerVersion(entry.latest, CLIENT_VERSION),
        assetUrl: entry.assetUrl,
        checkedAt: entry.checkedAt,
        cached,
        releasesPage: RELEASES_PAGE,
        ...(entry.error ? { error: entry.error } : {})
    };
}

/**
 * Ask GitHub for the latest release. Returns a cache entry either way — a
 * failed lookup is cached too, so a machine with no network doesn't retry on
 * every watcher tick.
 */
async function fetchLatest(timeoutMs: number): Promise<CacheFile> {
    const checkedAt = new Date().toISOString();
    try {
        const res = await fetch(LATEST_RELEASE_API, {
            headers: {
                accept: 'application/vnd.github+json',
                // GitHub rejects unidentified clients.
                'user-agent': `llm-usage-tracker/${CLIENT_VERSION}`
            },
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) {
            return { checkedAt, latest: null, assetUrl: null, error: `GitHub returned ${res.status}` };
        }
        const body = (await res.json()) as {
            tag_name?: string;
            assets?: { name?: string; browser_download_url?: string }[];
        };
        const tag = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/i, '') : '';
        if (!tag) return { checkedAt, latest: null, assetUrl: null, error: 'release has no tag' };

        const wanted = assetNameForHost();
        const asset = (body.assets ?? []).find((a) => a.name === wanted);
        return { checkedAt, latest: tag, assetUrl: asset?.browser_download_url ?? null };
    } catch (err: any) {
        const reason = err?.name === 'TimeoutError' ? 'lookup timed out' : 'network unavailable';
        return { checkedAt, latest: null, assetUrl: null, error: reason };
    }
}

/**
 * Current update status. Served from the day-old cache unless `force` is set,
 * so background callers are free.
 */
export async function checkForUpdate(
    opts: { force?: boolean; timeoutMs?: number } = {}
): Promise<UpdateStatus> {
    if (!opts.force) {
        const cached = readCache();
        if (cached) return statusFrom(cached, true);
    }
    const fresh = await fetchLatest(opts.timeoutMs ?? 8000);
    writeCache(fresh);
    return statusFrom(fresh, false);
}

/** Discard the cached lookup so the next check goes to the network. */
export function clearUpdateCache(): void {
    try {
        rmSync(cachePath());
    } catch {
        // nothing cached
    }
}

export interface ApplyResult {
    ok: boolean;
    from: string;
    to: string | null;
    message: string;
    /** Services restarted onto the new binary (empty if none was running). */
    restarted: string[];
}

/**
 * Download the latest release asset and swap it in for the running binary.
 *
 * The replace is a rename, which is atomic and safe while the old binary is
 * still executing (the running process keeps its open inode). Windows can't
 * rename over a running image at all, so the old one is moved aside first and
 * cleaned up on the next run.
 */
export async function applyUpdate(
    opts: { timeoutMs?: number; quiet?: boolean } = {}
): Promise<ApplyResult> {
    const log = (m: string) => {
        if (!opts.quiet) console.error(m);
    };
    const from = CLIENT_VERSION;

    if (!isCompiledBinary()) {
        return {
            ok: false,
            from,
            to: null,
            restarted: [],
            message: 'Running from source under bun — update the checkout with git instead.'
        };
    }

    const status = await checkForUpdate({ force: true, timeoutMs: opts.timeoutMs });
    if (!status.latest) {
        return { ok: false, from, to: null, restarted: [], message: `Update check failed: ${status.error}` };
    }
    if (!status.updateAvailable) {
        return { ok: true, from, to: status.latest, restarted: [], message: `Already on the latest version (${from}).` };
    }
    if (!status.assetUrl) {
        return {
            ok: false,
            from,
            to: status.latest,
            restarted: [],
            message: `Release ${status.latest} has no ${assetNameForHost()} asset.`
        };
    }

    const dest = process.execPath;
    const staging = join(dirname(dest), `.lut.update.${process.pid}`);

    log(`==> downloading ${status.latest} (${assetNameForHost()})`);
    try {
        const res = await fetch(status.assetUrl, {
            headers: { 'user-agent': `llm-usage-tracker/${from}` },
            redirect: 'follow',
            signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000)
        });
        if (!res.ok) throw new Error(`download returned ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        // A truncated or error-page download must never reach the install path;
        // every real target is tens of megabytes.
        if (bytes.byteLength < 1_000_000) {
            throw new Error(`downloaded ${bytes.byteLength} bytes — too small to be a binary`);
        }
        writeFileSync(staging, bytes);
        chmodSync(staging, 0o755);
    } catch (err: any) {
        try {
            rmSync(staging);
        } catch {
            // nothing staged
        }
        return { ok: false, from, to: status.latest, restarted: [], message: `Download failed: ${err?.message ?? err}` };
    }

    // Ad-hoc sign with a fixed identifier, exactly as install.sh does: codesign
    // would otherwise name the identity after the staging filename, changing the
    // binary's code identity on every update and making macOS re-ask for every
    // permission already granted.
    if (process.platform === 'darwin') {
        try {
            const { execFileSync } = await import('node:child_process');
            execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'lut', staging], {
                stdio: 'ignore'
            });
        } catch {
            log('    (codesign unavailable — continuing unsigned)');
        }
    }

    const parked = `${dest}.old`;
    try {
        if (process.platform === 'win32') {
            try {
                rmSync(parked);
            } catch {
                // no leftover from a previous update
            }
            renameSync(dest, parked);
        }
        renameSync(staging, dest);
    } catch (err: any) {
        // Put the old binary back rather than leaving nothing installed.
        if (process.platform === 'win32' && existsSync(parked) && !existsSync(dest)) {
            try {
                renameSync(parked, dest);
            } catch {
                // best effort
            }
        }
        try {
            rmSync(staging);
        } catch {
            // already gone
        }
        return { ok: false, from, to: status.latest, restarted: [], message: `Install failed: ${err?.message ?? err}` };
    }
    log(`==> installed ${status.latest} to ${dest}`);

    // The watcher service holds the old code in memory until restarted.
    const restarted: string[] = [];
    if (restartService()) {
        restarted.push('watchers');
        log('==> restarted the watcher service');
    }

    return {
        ok: true,
        from,
        to: status.latest,
        restarted,
        message: `Updated ${from} → ${status.latest}.`
    };
}
