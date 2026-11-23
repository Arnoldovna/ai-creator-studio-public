import { download, route } from '@/server/http';
import { read } from '@/server/store';

/**
 * Metadata backup (no media binaries), like the prototype's export. Since Etappe 11 everything (strategy, profile and
 * source documents, self-check notes, override reasons) is in db.json, so the export is db.json as it is.
 */
export const GET = route(async () => {
  const db = await read((d) => d);
  const body = JSON.stringify({
    ...db,
    backupNotice: 'Metadaten-Backup ohne Medien-Binärdateien (liegen unter .data/media). Enthält deine vollständigen Strategie-, Profil- und Quellen-Dokumente – nicht öffentlich teilen.',
    exportedAt: new Date().toISOString(),
  }, null, 2);
  return download(body, `creator-studio-backup-${new Date().toISOString().slice(0, 10)}.json`, 'json');
});
