/**
 * Client version, reported with every ingest event so the dashboard can show
 * who's on a stale build. Single source of truth — `lut version` prints it and
 * the release tag should match.
 */
export const CLIENT_VERSION = '1.5.0';
