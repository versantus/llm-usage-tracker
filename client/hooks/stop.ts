#!/usr/bin/env bun
/**
 * Claude Code Stop hook (standalone entrypoint for plugin / npx-bun installs).
 * The unified `lut` binary runs the same body via `lut hook`. Never throws.
 */

import { runHook } from './stdin.ts';
import { stopHookMain } from './run-stop.ts';

runHook(stopHookMain);
