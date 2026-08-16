/**
 * Chunked line reading for transcripts.
 *
 * Sources used to do `readFileSync(path, 'utf-8').split('\n')`, which holds the
 * whole file as one JS string *and* an array of every line at once — roughly
 * 2-3x the file size resident, for files that reach hundreds of megabytes on an
 * active machine (the largest session measured here was 246M tokens). Watchers
 * do this on a timer, so the peak recurred every cycle.
 *
 * This yields one line at a time from a fixed 64 KiB buffer, so memory is
 * constant regardless of file size. Callers that need several derived values
 * make one pass each rather than sharing an array — the second pass reads from
 * the OS page cache and costs far less than holding the file in the heap.
 */

import { closeSync, openSync, readSync } from 'node:fs';

/**
 * Read size. Tuned on a real 700MB corpus: 64 KiB reads cost ~4x the wall time
 * of one readFileSync (syscall + decode + concat overhead per chunk), while
 * 1 MiB matches it exactly and still halves peak memory. Larger buys nothing.
 */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Yield decoded text chunks from a UTF-8 file, for content that isn't
 * line-delimited (Gemini's OTEL outfile is a run of concatenated JSON objects).
 * Chunk boundaries fall anywhere, so consumers must carry state across them.
 *
 * Never throws — an unreadable or missing file yields nothing.
 */
export function* eachChunk(path: string): Generator<string> {
    let fd: number;
    try {
        fd = openSync(path, 'r');
    } catch {
        return;
    }
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const decoder = new TextDecoder('utf-8');
    try {
        for (;;) {
            let n: number;
            try {
                n = readSync(fd, buf, 0, CHUNK_BYTES, null);
            } catch {
                break;
            }
            if (n <= 0) break;
            const text = decoder.decode(buf.subarray(0, n), { stream: true });
            if (text) yield text;
        }
        const tail = decoder.decode();
        if (tail) yield tail;
    } finally {
        try {
            closeSync(fd);
        } catch {
            // already closed
        }
    }
}

/**
 * Yield non-blank lines from a UTF-8 text file. Never throws: an unreadable or
 * missing file yields nothing, matching the old readLines() behaviour.
 */
export function* eachLine(path: string): Generator<string> {
    let fd: number;
    try {
        fd = openSync(path, 'r');
    } catch {
        return; // missing or unreadable
    }

    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    // Streaming decode: a multi-byte character can straddle a chunk boundary,
    // and decoding each chunk independently would corrupt it.
    const decoder = new TextDecoder('utf-8');
    let carry = '';

    try {
        for (;;) {
            let n: number;
            try {
                n = readSync(fd, buf, 0, CHUNK_BYTES, null);
            } catch {
                break; // truncated or vanished mid-read — use what we have
            }
            if (n <= 0) break;

            carry += decoder.decode(buf.subarray(0, n), { stream: true });

            // Walk the buffer with an index and slice once at the end: slicing
            // `carry` per line is quadratic when lines are large, and transcript
            // lines routinely are.
            let start = 0;
            let nl = carry.indexOf('\n', start);
            while (nl !== -1) {
                const line = carry.slice(start, nl);
                if (line.trim()) yield line;
                start = nl + 1;
                nl = carry.indexOf('\n', start);
            }
            carry = start > 0 ? carry.slice(start) : carry;
        }
        carry += decoder.decode(); // flush any trailing partial sequence
        if (carry.trim()) yield carry;
    } finally {
        try {
            closeSync(fd);
        } catch {
            // already closed
        }
    }
}
