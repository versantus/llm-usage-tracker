import { describe, expect, test } from 'bun:test';

import { parseGeminiTelemetry } from './gemini-source.ts';

/**
 * The telemetry outfile is a run of concatenated JSON objects, not JSONL, and
 * it is now read as a chunk stream so an append-only file that never rotates
 * doesn't have to be resident in full. These tests pin the behaviour the chunk
 * scanner has to preserve: an object may be split at ANY byte, including inside
 * a string that itself contains braces.
 */

function metricPayload(sessionId: string, type: string, value: number, note = '') {
    return JSON.stringify({
        resourceMetrics: [
            {
                resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gemini-cli' } }] },
                scopeMetrics: [
                    {
                        metrics: [
                            {
                                name: 'gemini_cli.token.usage',
                                dataPoints: [
                                    {
                                        attributes: {
                                            'session.id': sessionId,
                                            type,
                                            model: 'gemini-2.5-pro',
                                            note
                                        },
                                        asInt: value
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ]
    });
}

/** Split a string into fixed-size pieces, mimicking arbitrary read boundaries. */
function chunked(text: string, size: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
}

describe('parseGeminiTelemetry', () => {
    const text =
        metricPayload('s1', 'input', 120) + metricPayload('s1', 'output', 45) + metricPayload('s2', 'input', 7);

    test('reads concatenated objects from a single chunk', () => {
        const sessions = parseGeminiTelemetry([text]);
        expect(sessions.get('s1')?.input).toBe(120);
        expect(sessions.get('s1')?.output).toBe(45);
        expect(sessions.get('s2')?.input).toBe(7);
        expect(sessions.get('s1')?.model).toBe('gemini-2.5-pro');
    });

    test('is identical when objects are split across chunk boundaries', () => {
        const whole = parseGeminiTelemetry([text]);
        // Several awkward sizes: each puts the boundary somewhere different,
        // including mid-object, mid-key and mid-number.
        for (const size of [1, 7, 13, 64, 511, 4096]) {
            const streamed = parseGeminiTelemetry(chunked(text, size));
            expect([...streamed.entries()].sort()).toEqual([...whole.entries()].sort());
        }
    });

    test('braces inside strings do not end an object early', () => {
        // A brace in a string value would close the object if the scanner
        // ignored string state — losing every metric after it.
        const tricky = metricPayload('s3', 'input', 99, 'a } brace { in a string');
        for (const size of [1, 5, 32, 1024]) {
            const sessions = parseGeminiTelemetry(chunked(tricky, size));
            expect(sessions.get('s3')?.input).toBe(99);
        }
    });

    test('an escaped quote inside a string does not confuse the scanner', () => {
        const tricky = metricPayload('s4', 'input', 5, 'quote \\" then } brace');
        for (const size of [1, 9, 256]) {
            expect(parseGeminiTelemetry(chunked(tricky, size)).get('s4')?.input).toBe(5);
        }
    });

    test('a truncated trailing object is skipped, not thrown', () => {
        const truncated = text + '{"resourceMetrics":[{"scopeMetrics"';
        const sessions = parseGeminiTelemetry(chunked(truncated, 100));
        expect(sessions.get('s1')?.input).toBe(120);
        expect(sessions.size).toBe(2);
    });
});
