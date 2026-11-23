'use client';
import type { ContextVersion } from '@/lib/types';
import { Pill } from '../ui';

export const STATUS_CHIP: Record<ContextVersion['status'], { label: string; tone: 'warn' | 'ok' | 'default' }> = {
  draft: { label: 'Entwurf', tone: 'warn' },
  approved: { label: 'Aktiv', tone: 'ok' },
  archived: { label: 'Archiviert', tone: 'default' },
};
export const StatusChip = ({ status }: { status: ContextVersion['status'] }) => <Pill tone={STATUS_CHIP[status].tone}>{STATUS_CHIP[status].label}</Pill>;

export const SOURCE_LABEL: Record<ContextVersion['source'], string> = {
  import: 'Import', manual: 'Bearbeitet', copy: 'Kopie', defaults: 'Standard-Ordner', import_bundle: 'Abgelegt', migration: 'Umgewandelt (Etappe 11)', chat: 'Aus dem Chat',
};
