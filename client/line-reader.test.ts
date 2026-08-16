import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eachChunk, eachLine } from './line-reader.ts';

// Must track CHUNK_BYTES in line-reader.ts: the interesting bugs all live at
// the read boundary, so the fixtures are sized around it deliberately.
const CHUNK = 1024 * 1024;

let dir: string;
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lut-line-reader-'));
});
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
}

describe('eachLine', () => {
    test('yields each line and skips blanks', () => {
        const p = write('basic.jsonl', '{"a":1}\n\n  \n{"b":2}\n');
        expect([...eachLine(p)]).toEqual(['{"a":1}', '{"b":2}']);
    });

    test('yields a final line with no trailing newline', () => {
        const p = write('no-trailing.jsonl', 'first\nsecond');
        expect([...eachLine(p)]).toEqual(['first', 'second']);
    });

    test('missing file yields nothing rather than throwing', () => {
        expect([...eachLine(join(dir, 'does-not-exist.jsonl'))]).toEqual([]);
    });

    test('empty file yields nothing', () => {
        expect([...eachLine(write('empty.jsonl', ''))]).toEqual([]);
    });

    test('handles a newline landing exactly on the chunk boundary', () => {
        // Pad so that byte CHUNK-1 is the newline ending line one.
        const first = 'x'.repeat(CHUNK - 1);
        const p = write('boundary.txt', `${first}\nsecond\n`);
        expect([...eachLine(p)]).toEqual([first, 'second']);
    });

    test('handles a multi-byte character split across the chunk boundary', () => {
        // '€' is 3 bytes in UTF-8. Land it so it straddles the 64 KiB read:
        // decoding each chunk independently would corrupt it into U+FFFD.
        const pad = 'a'.repeat(CHUNK - 1);
        const p = write('multibyte.txt', `${pad}€tail\n`);
        const lines = [...eachLine(p)];
        expect(lines).toHaveLength(1);
        expect(lines[0]).toBe(`${pad}€tail`);
        expect(lines[0]).not.toContain('�');
    });

    test('reads a single line far larger than one chunk', () => {
        // Transcript lines routinely exceed the buffer; the carry must grow to
        // fit rather than emit a truncated line.
        const huge = 'y'.repeat(CHUNK * 3 + 17);
        const p = write('huge-line.txt', `${huge}\nafter\n`);
        expect([...eachLine(p)]).toEqual([huge, 'after']);
    });

    test('matches readFileSync + split on a realistic multi-chunk file', () => {
        const lines = Array.from({ length: 5000 }, (_, i) =>
            JSON.stringify({ i, pad: 'z'.repeat(40), unicode: 'héllo →' })
        );
        const p = write('realistic.jsonl', lines.join('\n') + '\n');
        expect([...eachLine(p)]).toEqual(lines);
    });
});

describe('eachChunk', () => {
    test('concatenates back to the original content', () => {
        const content = 'ü'.repeat(CHUNK) + 'tail';
        const p = write('chunks.txt', content);
        expect([...eachChunk(p)].join('')).toBe(content);
    });

    test('missing file yields nothing', () => {
        expect([...eachChunk(join(dir, 'nope.txt'))]).toEqual([]);
    });
});
