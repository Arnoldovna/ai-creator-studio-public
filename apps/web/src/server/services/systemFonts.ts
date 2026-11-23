import 'server-only';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { FC_LIST_FORMAT, parseFcList, parseSystemProfiler, type InstalledFamily } from '@studio/core';

/**
 * Etappe 16b: the fonts installed on this Mac. `fc-list` (fontconfig, ships with Homebrew's FFmpeg; about 0.1 s) when it is
 * there, else `system_profiler SPFontsDataType -json` (CoreText's list, about 10 s). The list is cached in memory for 10
 * minutes (one run at a time) and can be refreshed. Nothing leaves the machine. Whether libass really takes a chosen face
 * is checked in the render log (`fontFallbacks` with the expected PostScript name), not here.
 */
const run = promisify(execFile);
const TTL_MS = 10 * 60 * 1000;
export interface SystemFontList { source: 'fc-list' | 'system_profiler' | 'none'; families: InstalledFamily[]; error: string | null; listedAt: string }

const g = globalThis as unknown as { __studioSystemFonts?: { at: number; value: SystemFontList } | null; __studioSystemFontsRun?: Promise<SystemFontList> | null };

const exists = (p: string) => access(p).then(() => true, () => false);
async function fcListPath(): Promise<string | null> {
  const env = process.env.FC_LIST;
  if (env === 'off') return null;
  for (const p of [env, '/opt/homebrew/bin/fc-list', '/usr/local/bin/fc-list', '/usr/bin/fc-list'].filter((x): x is string => !!x)) if (await exists(p)) return p;
  return null;
}

async function enumerate(): Promise<SystemFontList> {
  const listedAt = new Date().toISOString();
  const errors: string[] = [];
  const fc = await fcListPath();
  if (fc) {
    try {
      const { stdout } = await run(fc, ['--format', FC_LIST_FORMAT], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
      const families = parseFcList(stdout);
      if (families.length) return { source: 'fc-list', families, error: null, listedAt };
      errors.push('fc-list lieferte keine Schriften');
    } catch (e) {
      errors.push(`fc-list: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  if (process.platform === 'darwin' && process.env.SYSTEM_PROFILER !== 'off') {
    try {
      const { stdout } = await run('/usr/sbin/system_profiler', ['SPFontsDataType', '-json'], { timeout: 120_000, maxBuffer: 128 * 1024 * 1024 });
      const families = parseSystemProfiler(stdout);
      if (families.length) return { source: 'system_profiler', families, error: null, listedAt };
      errors.push('system_profiler lieferte keine Schriften');
    } catch (e) {
      errors.push(`system_profiler: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return { source: 'none', families: [], error: errors.join(' · ') || 'Keine Schriftliste verfügbar (weder fc-list noch system_profiler).', listedAt };
}

/** The installed fonts (cached; `refresh` lists them again). */
export async function listSystemFonts(opts: { refresh?: boolean } = {}): Promise<SystemFontList> {
  const c = g.__studioSystemFonts;
  if (!opts.refresh && c && Date.now() - c.at < TTL_MS) return c.value;
  g.__studioSystemFontsRun ??= enumerate().then((value) => {
    g.__studioSystemFonts = { at: Date.now(), value };
    return value;
  }).finally(() => { g.__studioSystemFontsRun = null; });
  return g.__studioSystemFontsRun;
}

/** Test hook: forget the cached list. */
export const resetSystemFontCache = () => { g.__studioSystemFonts = null; g.__studioSystemFontsRun = null; };
