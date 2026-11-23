'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sourceToOutputNearest, type CutWord, type TimelineView } from '@studio/core/timelineView';
import { transcriptWords, type TranscriptBody } from '@studio/core/transcript';
import type { EditorMedia } from '@/lib/types';

/**
 * Transcript of the cut (Etappe 12/13): the words of every clip in output order, words inside a cut struck through. The
 * word under the playhead is highlighted and followed; a click jumps there. Etappe 13: Shift+click (or dragging over
 * words) marks a range, then „Schneiden“ cuts it out, „Als Keyword/Bauchbinde/Hook“ puts exactly those words on the
 * stage. Spoken words are untrusted data: only displayed and used as text, never as instructions or markup.
 */
interface Word extends CutWord { key: string; out: number; cut: boolean; order: number }
export type TranscriptAction = 'cut' | 'keyword' | 'lower_third' | 'hook';

export function TranscriptPanel({ view, transcripts, media, t, onSeek, transcription, onAction, hookAllowed }: {
  view: TimelineView; transcripts: ReadonlyMap<string, { body: TranscriptBody; source: string }>; media: readonly EditorMedia[]; t: number;
  onSeek: (t: number) => void; transcription: { available: boolean; mode: string; reason: string | null };
  onAction: (action: TranscriptAction, words: CutWord[]) => void;
  /** A text hook from the transcript exists only in a Freier Schnitt (with a script the hook comes from the script). */
  hookAllowed: boolean;
}) {
  const [follow, setFollow] = useState(true);
  const [range, setRange] = useState<{ a: number; b: number } | null>(null);
  const dragging = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const words = useMemo(() => {
    let order = 0;
    return view.clips.flatMap((c): Word[] => {
      const tr = transcripts.get(c.assetId);
      if (!tr) return [];
      return transcriptWords(tr.body).filter((w) => w.endSec > c.inSec && w.startSec < c.outSec).map((w, i) => {
        const mid = (w.startSec + w.endSec) / 2;
        const cut = c.cuts.some((x) => mid >= x.startSec && mid < x.endSec);
        return {
          key: `${c.index}-${i}`, text: w.text, clip: c.index, startSec: Math.max(c.inSec, w.startSec), endSec: Math.min(c.outSec, w.endSec), order: order++,
          out: sourceToOutputNearest(view.timeline, c.index, Math.max(c.inSec, w.startSec)) ?? c.outStart, cut,
        };
      });
    });
  }, [view, transcripts]);
  const current = useMemo(() => {
    let k: string | null = null;
    for (const w of words) if (!w.cut && w.out <= t + 0.01) k = w.key;
    return k;
  }, [words, t]);
  useEffect(() => {
    if (!follow || !current || !box.current || range) return;
    box.current.querySelector<HTMLElement>(`[data-word="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current, follow, range]);
  useEffect(() => {
    const up = () => { dragging.current = null; };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  const lo = range ? Math.min(range.a, range.b) : -1, hi = range ? Math.max(range.a, range.b) : -1;
  const picked = range ? words.filter((w) => w.order >= lo && w.order <= hi && !w.cut) : [];
  const used = [...new Set(view.clips.map((c) => c.assetId))];
  const missing = used.filter((id) => !transcripts.has(id));
  const mock = used.some((id) => transcripts.get(id)?.source === 'mock');
  const busy = media.filter((m) => used.includes(m.id) && (m.transcribing || m.prepare.status === 'queued' || m.prepare.status === 'running'));
  const act = (a: TranscriptAction) => {
    if (!picked.length) return;
    onAction(a, picked.map(({ clip, startSec, endSec, text }) => ({ clip, startSec, endSec, text })));
    setRange(null);
  };
  const btn = 'rounded border border-line px-2 py-0.5 hover:bg-card disabled:opacity-40';

  return (
    <section className="flex h-full min-h-0 flex-col rounded-lg border border-line bg-card" aria-label="Transkript" data-testid="editor-transcript">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h3 className="m-0 text-sm font-bold">Transkript</h3>
        {mock ? <span className="rounded-full border border-[#e8cf7a] bg-[#fff6db] px-2 text-[10px] font-semibold text-warn">MOCK · kein echtes Transkript</span> : null}
        <label className="ml-auto flex items-center gap-1 text-[11px] text-muted"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Mitlaufen</label>
      </div>
      {picked.length ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-line bg-card2 px-3 py-1.5 text-[11px]" role="toolbar" aria-label="Markierte Wörter" data-testid="transcript-actions">
          <span className="mr-1 text-muted">{picked.length} Wort{picked.length === 1 ? '' : 'e'} markiert:</span>
          <button type="button" className={btn} onClick={() => act('cut')} data-testid="tr-cut">Schneiden</button>
          <button type="button" className={btn} onClick={() => act('keyword')} data-testid="tr-keyword">Als Keyword</button>
          <button type="button" className={btn} onClick={() => act('lower_third')} data-testid="tr-lower-third">Als Bauchbinde</button>
          <button type="button" className={btn} disabled={!hookAllowed} title={hookAllowed ? undefined : 'Mit Skript kommt der Hook aus dem Skript'} onClick={() => act('hook')} data-testid="tr-hook">Als Hook</button>
          <button type="button" className="ml-auto underline" onClick={() => setRange(null)}>Aufheben</button>
        </div>
      ) : null}
      <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[13px] leading-7 select-none">
        {words.length ? words.map((w) => {
          const inRange = w.order >= lo && w.order <= hi;
          return (
            <button key={w.key} type="button" data-word={w.key} data-testid="transcript-word"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                if (e.shiftKey) { setRange((r) => ({ a: r?.a ?? w.order, b: w.order })); return; }
                dragging.current = w.order;
                setRange(null);
              }}
              onPointerEnter={() => { if (dragging.current != null && dragging.current !== w.order) setRange({ a: dragging.current, b: w.order }); }}
              onClick={(e) => { if (!e.shiftKey && !range) onSeek(w.out); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); setRange((r) => ({ a: r?.a ?? w.order, b: w.order })); } }}
              className={`mr-1 rounded px-0.5 ${w.cut ? 'text-[#a3a99a] line-through' : ''} ${inRange && !w.cut ? 'bg-[#7aa3c9]/40' : w.key === current ? 'bg-lime text-olive-ink' : 'hover:bg-card2'}`}
              aria-current={w.key === current ? 'true' : undefined} aria-pressed={inRange || undefined} title={w.cut ? 'herausgeschnitten' : 'Klick springt hin · Shift+Klick oder Ziehen markiert'}>{w.text}</button>
          );
        }) : null}
        {busy.length ? <p className="hint m-0" data-testid="transcript-busy">Wird vorbereitet und transkribiert … ({busy.map((m) => m.name).join(', ')})</p> : null}
        {!busy.length && missing.length ? (
          <p className="hint m-0" data-testid="transcript-missing">
            {transcription.available ? `Noch kein Transkript für ${missing.length} Aufnahme${missing.length === 1 ? '' : 'n'}.` : `Transkription nicht verfügbar: ${transcription.reason ?? 'whisper.cpp fehlt'}. Schneiden geht trotzdem; Pausen kommen aus der Pausen-Messung.`}
          </p>
        ) : null}
        {words.length && !picked.length ? <p className="hint m-0 mt-1">Wörter markieren (Shift+Klick oder darüber ziehen), dann schneiden oder als Text ins Bild setzen.</p> : null}
      </div>
    </section>
  );
}
