import { describe, expect, test } from 'bun:test';

import {
    getFirstTimestamp,
    getLastTimestamp,
    parseTranscriptLines,
    scanTranscript
} from './transcript-parser.ts';

/**
 * scanTranscript() fuses parseTranscriptLines + getFirstTimestamp +
 * getLastTimestamp into one walk so collectors can stream a transcript instead
 * of holding an array of every line. These tests pin it to the behaviour of the
 * three functions it replaced — including the dedup rule, which is the one that
 * silently doubles everyone's token counts if it regresses.
 */

const assistant = (id: string, ts: string, usage: Record<string, number>, model = 'claude-sonnet-5') =>
    JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: { id, model, usage }
    });

const LINES = [
    JSON.stringify({ type: 'user', timestamp: '2026-08-16T09:00:00Z' }),
    assistant('msg_1', '2026-08-16T09:00:05Z', { input_tokens: 100, output_tokens: 20 }),
    // Same message.id: one API response written as several content-block lines.
    // Each carries the FULL usage, so counting both double-counts the session.
    assistant('msg_1', '2026-08-16T09:00:06Z', { input_tokens: 100, output_tokens: 20 }),
    assistant('msg_2', '2026-08-16T09:01:00Z', {
        input_tokens: 5,
        output_tokens: 7,
        cache_creation_input_tokens: 11,
        cache_read_input_tokens: 13
    }),
    'not json at all',
    JSON.stringify({ type: 'user', timestamp: '2026-08-16T09:02:00Z' })
];

describe('scanTranscript', () => {
    test('produces the same records as parseTranscriptLines', () => {
        expect(scanTranscript(LINES).records).toEqual(parseTranscriptLines(LINES));
    });

    test('dedupes repeated message.id, keeping one record per response', () => {
        const { records } = scanTranscript(LINES);
        expect(records).toHaveLength(2);
        expect(records.map((r) => r.requestId)).toEqual(['msg_1', 'msg_2']);
        expect(records[0].inputTokens).toBe(100);
        expect(records[1].cacheCreationTokens).toBe(11);
        expect(records[1].cacheReadTokens).toBe(13);
    });

    test('timestamps match the standalone helpers', () => {
        const scan = scanTranscript(LINES);
        expect(scan.firstTimestamp).toBe(getFirstTimestamp(LINES));
        expect(scan.lastTimestamp).toBe(getLastTimestamp(LINES));
        // extractTimestamp normalises through Date.toISOString(), so the
        // milliseconds are always present even when the source omits them.
        expect(scan.firstTimestamp).toBe('2026-08-16T09:00:00.000Z');
        expect(scan.lastTimestamp).toBe('2026-08-16T09:02:00.000Z');
    });

    test('consumes a one-shot iterator, not just an array', () => {
        // The whole point: the input is a streaming reader that can only be
        // walked once, so nothing inside may re-iterate it.
        function* once() {
            yield* LINES;
        }
        const scan = scanTranscript(once());
        expect(scan.records).toHaveLength(2);
        expect(scan.firstTimestamp).toBe('2026-08-16T09:00:00.000Z');
        expect(scan.lastTimestamp).toBe('2026-08-16T09:02:00.000Z');
    });

    test('an empty transcript yields no records and null timestamps', () => {
        const scan = scanTranscript([]);
        expect(scan.records).toEqual([]);
        expect(scan.firstTimestamp).toBeNull();
        expect(scan.lastTimestamp).toBeNull();
    });

    test('a transcript with no timestamps still yields records', () => {
        const lines = [JSON.stringify({ type: 'assistant', message: { id: 'm', usage: { input_tokens: 3 } } })];
        const scan = scanTranscript(lines);
        expect(scan.records).toHaveLength(1);
        expect(scan.firstTimestamp).toBeNull();
    });
});

describe('getLastTimestamp', () => {
    test('returns the final timestamp when later lines have none', () => {
        // It scans forward now (an iterable has no index), so it must keep the
        // most recent hit rather than stopping at the first one it sees.
        const lines = [
            JSON.stringify({ timestamp: '2026-08-16T09:00:00Z' }),
            JSON.stringify({ timestamp: '2026-08-16T10:00:00Z' }),
            'trailing junk with no timestamp'
        ];
        expect(getLastTimestamp(lines)).toBe('2026-08-16T10:00:00.000Z');
    });
});
