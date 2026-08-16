import { describe, expect, test } from 'bun:test';

import { compareVersions, isNewerVersion, parseVersion } from './version.ts';

describe('parseVersion', () => {
    test('strips a leading v and splits on dots', () => {
        expect(parseVersion('v1.6.0')).toEqual([1, 6, 0]);
        expect(parseVersion('1.6.0')).toEqual([1, 6, 0]);
    });

    test('drops prerelease and build suffixes', () => {
        expect(parseVersion('1.6.0-rc.1')).toEqual([1, 6, 0]);
        expect(parseVersion('1.6.0+build7')).toEqual([1, 6, 0]);
    });

    test('malformed parts read as 0 rather than NaN', () => {
        expect(parseVersion('1.x.3')).toEqual([1, 0, 3]);
        expect(parseVersion('nonsense')).toEqual([0]);
    });
});

describe('compareVersions', () => {
    test('orders by numeric precedence, not string order', () => {
        // The bug this guards: "1.10.0" < "1.9.0" under a string compare.
        expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
        expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    });

    test('treats equal versions as equal regardless of v prefix', () => {
        expect(compareVersions('v1.6.0', '1.6.0')).toBe(0);
    });

    test('pads missing components with zero', () => {
        expect(compareVersions('1.6', '1.6.0')).toBe(0);
        expect(compareVersions('1.6.1', '1.6')).toBe(1);
        expect(compareVersions('2', '1.99.99')).toBe(1);
    });
});

describe('isNewerVersion', () => {
    test('is strict — the same version is not an update', () => {
        expect(isNewerVersion('1.6.0', '1.6.0')).toBe(false);
    });

    test('detects a newer release', () => {
        expect(isNewerVersion('1.6.1', '1.6.0')).toBe(true);
        expect(isNewerVersion('v1.7.0', '1.6.0')).toBe(true);
    });

    test('never offers a downgrade', () => {
        // A yanked release, or a machine running a locally built binary that is
        // ahead of the published tag, must not be pushed backwards.
        expect(isNewerVersion('1.5.1', '1.6.0')).toBe(false);
    });

    test('an unparseable tag sorts low instead of triggering an update', () => {
        expect(isNewerVersion('garbage', '1.6.0')).toBe(false);
    });
});
