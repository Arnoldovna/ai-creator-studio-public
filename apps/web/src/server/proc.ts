import 'server-only';
import type { ChildProcess } from 'node:child_process';

/**
 * Waits for a spawned tool (FFmpeg, whisper.cpp). Aborting sends SIGTERM, then SIGKILL after 3 s, and
 * rejects with an AbortError; a non-zero exit rejects with the last lines of the tool's stderr.
 */
export async function waitForChild(child: ChildProcess, opts: { signal?: AbortSignal; label: string; tail: () => string }): Promise<void> {
  let killTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    killTimer.unref();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    opts.signal?.throwIfAborted();
    if (code !== 0) throw new Error(`${opts.label} ist mit Code ${code} beendet: ${opts.tail().trim().split('\n').slice(-3).join(' ') || 'ohne Meldung'}`);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    clearTimeout(killTimer);
  }
}
