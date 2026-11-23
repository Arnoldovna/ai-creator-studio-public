/** Writes a transcript body where the studio keeps it (`transcripts/<projectId>/<id>.json`); returns the storage path. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptBody } from '@studio/core';

export async function writeTranscriptFile(projectId: string, id: string, body: TranscriptBody) {
  const { absolutePath } = await import('@/server/media');
  const storagePath = `transcripts/${projectId}/${id}.json`;
  await mkdir(path.dirname(absolutePath(storagePath)), { recursive: true });
  await writeFile(absolutePath(storagePath), JSON.stringify(body), 'utf8');
  return storagePath;
}
