'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { BOARD_KIND_LABEL, BOARD_STATUS_LABEL, BOARD_STATUSES, addDays, type BoardKind, type BoardStatus } from '@studio/core/week';
import { api, useApi } from '@/lib/api';
import type { BoardItemView, BoardView } from '@/lib/types';
import { ChatButton, useChatScope } from '../chat/ChatProvider';
import { useToast } from '../toast';
import { Button, ErrorNote, Field, MockBadge, PageHeader, Pill } from '../ui';

/**
 * Wochenboard (Etappe 20): one week Mo–So in her rhythm – without pressure: no reminders, no streaks, no „missed“, empty
 * days are just empty. Items come from all her material (finished reels, drafts, carousels, stories, concepts) or are her
 * own ideas; drag & drop or Alt+←/→ moves them, the status is hers („gepostet“ only by her click, optional link/date).
 * „Woche füllen“ suggests something for empty days (taken over one by one). Nothing is posted or scheduled.
 */
const usd = (x: number | null | undefined) => (x == null ? '—' : x === 0 ? 'kostenlos' : `ca. $${x < 0.01 ? x.toFixed(4) : x.toFixed(3)}`);
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dm = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.`;
const KIND_TONE: Record<BoardKind, string> = { reel: 'bg-[#e6f0d2] text-[#2f3d10]', carousel: 'bg-[#e3ecf6] text-[#1d3550]', story: 'bg-[#f6e9f0] text-[#5a2140]', idea: 'bg-[#f2f4ec] text-[#454d3d]' };

export function WeekBoard() {
  const params = useSearchParams();
  const toast = useToast();
  const [week, setWeek] = useState(params.get('week') ?? localToday());
  const board = useApi<BoardView>(`/api/board?week=${week}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const b = board.data;
  useChatScope(b ? { scope: 'week', label: 'Wochenboard', weekStart: b.weekStart, onApplied: async () => { await board.reload(); } } : null);

  const patch = async (id: string, json: Record<string, unknown>, done?: string) => {
    setError(null);
    try {
      await api(`/api/board/items/${id}`, { method: 'PATCH', json });
      await board.reload();
      if (done) toast(done);
      return true;
    } catch (e) {
      setError((e as Error).message);
      await board.reload();
      return false;
    }
  };
  const move = (item: BoardItemView, date: string | null, index?: number) => patch(item.id, { date, ...(index != null ? { index } : {}) }, date ? `Verschoben auf ${b?.days.find((d) => d.date === date)?.weekday ?? date}.` : 'Nach „ohne Tag“ verschoben.');
  const onDrop = (date: string | null) => async (e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    const item = b ? [...b.days.flatMap((d) => d.items), ...b.unscheduled].find((x) => x.id === id) : null;
    if (item && item.date !== date) await move(item, date);
  };

  async function fill() {
    if (!b) return;
    setBusy('fill');
    setError(null);
    try {
      await api('/api/board/plan', { method: 'POST', json: { week: b.weekStart } });
      await board.reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  async function decide(id: string, what: 'accept' | 'dismiss') {
    setBusy(`${what}-${id}`);
    setError(null);
    try {
      await api(`/api/board/suggestions/${id}/${what}`, { method: 'POST' });
      await board.reload();
      if (what === 'accept') toast('Übernommen – steht jetzt auf dem Board.');
    } catch (e) { setError((e as Error).message); await board.reload(); } finally { setBusy(null); }
  }

  return (
    <div className="appear">
      <PageHeader
        eyebrow="WOCHE · IN DEINEM RHYTHMUS"
        title="Deine Woche,"
        accent="ohne Druck."
        lead="Was diese Woche dran sein könnte – Reels, Karussells, Stories und Ideen aus deinem Material. Leere Tage sind okay. Das Studio erinnert nicht, zählt keine Serien und postet nie selbst; „gepostet“ setzt nur du."
        right={<ChatButton />}
      />
      {b ? (
        <>
          <nav aria-label="Woche wechseln" className="mb-4 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setWeek(b.prev)} data-testid="week-prev" aria-label="Vorherige Woche">← Vorherige</Button>
            <Button size="sm" onClick={() => setWeek(localToday())} disabled={b.days.some((d) => d.date === b.today)}>Diese Woche</Button>
            <Button size="sm" onClick={() => setWeek(b.next)} data-testid="week-next" aria-label="Nächste Woche">Nächste →</Button>
            <h2 className="m-0 ml-2 text-base font-bold" data-testid="week-label" aria-live="polite">{b.label}</h2>
            <span className="ml-auto flex gap-2 text-[11px]">
              <a className="underline" href={`/api/board/export?week=${b.weekStart}&format=txt`} data-testid="week-export-txt">Als Liste (.txt)</a>
              <a className="underline" href={`/api/board/export?week=${b.weekStart}&format=ics`} title="Ganztägige Kalendereinträge ohne Erinnerungen">Kalender (.ics, ohne Alarme)</a>
            </span>
          </nav>
          <ErrorNote error={error} />
          <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="panel" aria-label="Rhythmus und Säulen-Mix" data-testid="week-info">
              <p className="m-0 text-xs text-[#454d3d]" data-testid="week-rhythm">
                {b.rhythm.postsPerWeek != null ? <>Dein Rhythmus laut Strategie: <strong>{b.rhythm.postsPerWeek} Posts pro Woche</strong> – nur Orientierung.</> : <>Kein Rhythmus in der Strategie festgelegt – plane, wie es passt.</>}
                {' '}Geplant: {b.rhythm.planned} Hauptpost{b.rhythm.planned === 1 ? '' : 's'}.{b.rhythm.notes ? <span className="text-muted"> ({b.rhythm.notes})</span> : null}
              </p>
              {b.mix.rows.length ? (
                <div className="mt-2 grid gap-1" data-testid="week-mix" aria-label="Säulen-Mix der Woche (nur Information)">
                  {b.mix.rows.map((r) => (
                    <div key={r.pillarId} className="grid grid-cols-[110px_minmax(0,1fr)_auto] items-center gap-2 text-[11px] text-muted">
                      <span className="truncate">{r.name}</span>
                      <span className="relative h-1.5 overflow-hidden rounded-full bg-[#eef0e8]" aria-hidden>
                        <span className="absolute inset-y-0 left-0 rounded-full bg-[#b9c79a]" style={{ width: `${r.share}%` }} />
                        <span className="absolute inset-y-0 w-px bg-[#6b7560]" style={{ left: `${r.targetShare}%` }} />
                      </span>
                      <span>{r.count} · {r.share} % (Ziel {r.targetShare} %)</span>
                    </div>
                  ))}
                  {b.mix.withoutPillar ? <span className="text-[11px] text-muted">{b.mix.withoutPillar} ohne Säule</span> : null}
                </div>
              ) : null}
            </section>
            <section className="panel" aria-label="Woche füllen" data-testid="week-fill-panel">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 mr-auto text-sm font-bold">Woche füllen</h3>
                <span className="text-[11px] text-muted">Modell: {b.estimate.label} · {usd(b.estimate.estCostUsd)}</span>
                <Button size="sm" variant="primary" busy={busy === 'fill'} onClick={() => void fill()} data-testid="week-fill">Vorschläge für leere Tage</Button>
              </div>
              <p className="hint mt-1 mb-0">Nur für leere Tage, höchstens so viele Hauptposts, wie dein Rhythmus noch zulässt – vorhandenes Material zuerst. Jeder Vorschlag einzeln übernehmen.</p>
              {b.plan ? (
                <div className="mt-2">
                  {b.plan.mock ? <MockBadge mock /> : null}
                  {b.plan.suggestions.length ? (
                    <ul className="mt-2 grid gap-1.5 p-0" data-testid="week-suggestions">
                      {b.plan.suggestions.map((s) => (
                        <li key={s.id} className="flex list-none flex-wrap items-center gap-2 rounded-lg border border-line px-2 py-1.5 text-xs" data-testid="week-suggestion">
                          <span className="w-20 shrink-0 font-semibold">{b.days.find((d) => d.date === s.date)?.weekday ?? s.date}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${KIND_TONE[s.kind]}`}>{BOARD_KIND_LABEL[s.kind]}</span>
                          <span className="min-w-0 flex-1 truncate" title={s.reason}>{s.title}{s.ref ? <span className="text-muted"> · vorhanden</span> : null}</span>
                          <Button size="sm" busy={busy === `accept-${s.id}`} onClick={() => void decide(s.id, 'accept')} data-testid="suggestion-accept">Übernehmen</Button>
                          <Button size="sm" variant="ghost" onClick={() => void decide(s.id, 'dismiss')} aria-label={`Vorschlag „${s.title}“ verwerfen`}>✕</Button>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="hint mt-2 mb-0">Keine offenen Vorschläge.</p>}
                  {b.plan.notes ? <p className="hint mt-1 mb-0">{b.plan.notes}</p> : null}
                </div>
              ) : null}
            </section>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7" data-testid="week-grid">
            {b.days.map((d) => (
              <section key={d.date} aria-label={`${d.weekday}, ${dm(d.date)}`} data-testid="week-day" data-date={d.date}
                onDragOver={(e) => e.preventDefault()} onDrop={onDrop(d.date)}
                className={`flex min-h-[220px] min-w-0 flex-col gap-2 rounded-xl border p-2 ${d.date === b.today ? 'border-[#9fb46b] bg-[#fbfcf7]' : 'border-line bg-card'}`}>
                <h3 className="m-0 flex items-baseline gap-1.5 text-xs font-bold">{d.weekday}<span className="font-normal text-muted">{dm(d.date)}{d.date === b.today ? ' · heute' : ''}</span></h3>
                <ItemList items={d.items.filter((i) => i.slot === 'main')} label="Hauptpost" board={b} onMove={move} onPatch={patch} onReload={board.reload} />
                <ItemList items={d.items.filter((i) => i.slot === 'story')} label="Stories" board={b} onMove={move} onPatch={patch} onReload={board.reload} />
                <AddItem date={d.date} board={b} onAdded={board.reload} />
              </section>
            ))}
          </div>
          <section className="mt-4 rounded-xl border border-dashed border-line p-3" aria-label="Ohne Tag" data-testid="week-unscheduled"
            onDragOver={(e) => e.preventDefault()} onDrop={onDrop(null)}>
            <h3 className="m-0 mb-2 text-xs font-bold">Ohne Tag <span className="font-normal text-muted">– Ideen und Verschobenes, bleibt hier, bis du es einplanst</span></h3>
            <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-5">
              {b.unscheduled.map((i) => <Card key={i.id} item={i} board={b} onMove={move} onPatch={patch} onReload={board.reload} />)}
            </div>
            <div className="mt-2 max-w-sm"><AddItem date={null} board={b} onAdded={board.reload} /></div>
          </section>
        </>
      ) : board.error ? <ErrorNote error={board.error} /> : <p className="hint">Lade Woche …</p>}
    </div>
  );
}

type Handlers = { board: BoardView; onMove: (item: BoardItemView, date: string | null, index?: number) => Promise<boolean>; onPatch: (id: string, json: Record<string, unknown>, done?: string) => Promise<boolean>; onReload: () => Promise<void> };

function ItemList({ items, label, ...h }: { items: BoardItemView[]; label: string } & Handlers) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[10px] tracking-wider text-muted uppercase">{label}</span>
      {items.map((i) => <Card key={i.id} item={i} {...h} />)}
    </div>
  );
}

function Card({ item, board, onMove, onPatch, onReload }: { item: BoardItemView } & Handlers) {
  const toast = useToast();
  const [open, setOpen] = useState<'post' | 'metrics' | null>(null);
  const [postedAt, setPostedAt] = useState(item.posted?.at ?? item.date ?? localToday());
  const [link, setLink] = useState(item.posted?.permalink ?? '');
  const [m, setM] = useState({ window: '7d', reach: '', views: '', saves: '', shares: '', likes: '', comments: '' });
  const [projectId, setProjectId] = useState(item.projectId ?? board.projects[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const days = board.days.map((d) => d.date);
  const onKey = (e: KeyboardEvent) => {
    // review fix: only on the card itself (not while typing in its fields), and never out of the visible week
    if (!e.altKey || e.target !== e.currentTarget) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const to = item.date && days.includes(item.date) ? addDays(item.date, e.key === 'ArrowLeft' ? -1 : 1) : days[0]!;
      if (days.includes(to) && to !== item.date) void onMove(item, to);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      void onMove(item, item.date, Math.max(0, item.order + (e.key === 'ArrowUp' ? -1 : 1)));
    }
  };
  async function saveMetrics() {
    setError(null);
    const n = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.round(Number(s))));
    try {
      // review fix: never invent a 0 – the four required figures must be typed in (the form blocks submit)
      await api(`/api/board/items/${item.id}/metrics`, { method: 'POST', json: { window: m.window, reach: n(m.reach), views: n(m.views), saves: n(m.saves), shares: n(m.shares), likes: n(m.likes), comments: n(m.comments), projectId: projectId || null } });
      toast('Kennzahlen im Rückblick gespeichert.');
      setOpen(null);
      await onReload();
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <article draggable tabIndex={0} onDragStart={(e) => { e.dataTransfer.setData('text/plain', item.id); e.dataTransfer.effectAllowed = 'move'; }} onKeyDown={onKey}
      aria-label={`${BOARD_KIND_LABEL[item.kind]}: ${item.title} (${BOARD_STATUS_LABEL[item.status]}). Alt+Pfeil links/rechts verschiebt den Tag.`}
      className={`grid min-w-0 gap-1 overflow-hidden rounded-lg border bg-white p-2 text-xs shadow-sm focus-visible:outline-2 focus-visible:outline-[#4a6116] ${item.status === 'posted' ? 'border-[#c9de9a]' : 'border-line'}`} data-testid="board-item" data-kind={item.kind}>
      <div className="flex items-center gap-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${KIND_TONE[item.kind]}`}>{BOARD_KIND_LABEL[item.kind]}</span>
        {item.status === 'posted' ? <Pill tone="ok">gepostet{item.posted?.at ? ` ${dm(item.posted.at)}` : ''}</Pill> : null}
        {item.origin === 'planner' ? <span className="text-[10px] text-muted" title="aus „Woche füllen“">✳</span> : null}
      </div>
      <strong className="leading-snug font-semibold break-words" data-testid="board-item-title">{item.title}</strong>
      {item.pillarName ? <span className="text-[10px] text-muted">Säule: {item.pillarName}</span> : null}
      {item.refState ? <span className="text-[10px] text-muted">{item.refState}</span> : null}
      <div className="grid gap-1">
        <select aria-label={`Status von „${item.title}“`} className="field w-full min-w-0 py-0.5 text-[11px]" value={item.status} data-testid="board-item-status"
          onChange={(e) => { const s = e.target.value as BoardStatus; if (s === 'posted') setOpen('post'); else void onPatch(item.id, { status: s }); }}>
          {BOARD_STATUSES.map((s) => <option key={s} value={s}>{BOARD_STATUS_LABEL[s]}</option>)}
        </select>
        {item.href ? <Link href={item.href} className="text-[11px] font-semibold text-accent underline" data-testid="board-item-open">Im Editor öffnen →</Link> : null}
      </div>
      <details className="text-[11px]">
        <summary className="cursor-pointer text-muted">Mehr</summary>
        <div className="mt-1 grid gap-1.5">
          <label className="grid gap-0.5">Tag
            <select className="field py-0.5 text-[11px]" value={item.date && days.includes(item.date) ? item.date : item.date ?? ''} onChange={(e) => void onMove(item, e.target.value || null)} data-testid="board-item-day">
              <option value="">ohne Tag</option>
              {board.days.map((d) => <option key={d.date} value={d.date}>{d.weekday} {dm(d.date)}</option>)}
              {item.date && !days.includes(item.date) ? <option value={item.date}>{item.date}</option> : null}
            </select>
          </label>
          {item.status !== 'posted' ? <Button size="sm" onClick={() => setOpen('post')} data-testid="board-item-mark-posted">Als gepostet markieren …</Button> : null}
          {item.status === 'posted' ? <Button size="sm" onClick={() => setOpen('metrics')} data-testid="board-item-metrics">Kennzahlen nachtragen …</Button> : null}
          {item.publication ? <span className="text-muted">Im Rückblick{item.publication.latest ? `: ${item.publication.latest.metrics.reach} Reichweite (${item.publication.latest.window})` : ''}</span> : null}
          <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/board/items/${item.id}`, { method: 'DELETE' }); await onReload(); }}>Vom Board nehmen</Button>
        </div>
      </details>
      {open === 'post' ? (
        <form className="grid gap-1 rounded border border-line p-1.5" data-testid="board-post-form" onSubmit={async (e) => { e.preventDefault(); if (await onPatch(item.id, { posted: { at: postedAt, permalink: link.trim() } }, 'Als gepostet markiert.')) setOpen(null); }}>
          <span className="text-[10px] text-muted">Du hast es selbst gepostet – das Studio postet nie.</span>
          <label className="grid gap-0.5 text-[10px]">Datum<input type="date" className="field py-0.5 text-[11px]" value={postedAt} onChange={(e) => setPostedAt(e.target.value)} /></label>
          <label className="grid gap-0.5 text-[10px]">Link (optional)<input type="url" className="field py-0.5 text-[11px]" placeholder="https://www.instagram.com/…" value={link} onChange={(e) => setLink(e.target.value)} /></label>
          <div className="flex gap-1"><Button size="sm" variant="primary" type="submit" data-testid="board-post-confirm">Gepostet</Button><Button size="sm" variant="ghost" type="button" onClick={() => setOpen(null)}>Abbrechen</Button></div>
        </form>
      ) : null}
      {open === 'metrics' ? (
        <form className="grid gap-1 rounded border border-line p-1.5" onSubmit={(e) => { e.preventDefault(); void saveMetrics(); }}>
          <span className="text-[10px] text-muted">Von Hand aus Instagram abgeschrieben (keine Verbindung zu Instagram).</span>
          {!item.projectId ? (
            <label className="grid gap-0.5 text-[10px]">Projekt<select className="field py-0.5 text-[11px]" value={projectId} onChange={(e) => setProjectId(e.target.value)}>{board.projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
          ) : null}
          <label className="grid gap-0.5 text-[10px]">Zeitraum<select className="field py-0.5 text-[11px]" value={m.window} onChange={(e) => setM({ ...m, window: e.target.value })}><option value="24h">24 h</option><option value="7d">7 Tage</option><option value="30d">30 Tage</option></select></label>
          {(['reach', 'views', 'saves', 'shares', 'likes', 'comments'] as const).map((k) => (
            <label key={k} className="grid grid-cols-[80px_1fr] items-center gap-1 text-[10px]">{{ reach: 'Reichweite', views: 'Aufrufe', saves: 'Gespeichert', shares: 'Geteilt', likes: 'Likes (opt.)', comments: 'Kommentare (opt.)' }[k]}
              <input type="number" min={0} required={k === 'reach' || k === 'views' || k === 'saves' || k === 'shares'} className="field py-0.5 text-[11px]" value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })} />
            </label>
          ))}
          <div className="flex gap-1"><Button size="sm" variant="primary" type="submit">Speichern</Button><Button size="sm" variant="ghost" type="button" onClick={() => setOpen(null)}>Abbrechen</Button></div>
          <ErrorNote error={error} />
        </form>
      ) : null}
    </article>
  );
}

function AddItem({ date, board, onAdded }: { date: string | null; board: BoardView; onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<BoardKind>('idea');
  const [error, setError] = useState<string | null>(null);
  const free = board.material.filter((m) => !m.onBoard);
  if (!open) return <button type="button" className="mt-auto rounded border border-dashed border-line py-1 text-[11px] text-muted hover:text-ink" onClick={() => setOpen(true)} aria-label={`Etwas eintragen${date ? ` am ${board.days.find((d) => d.date === date)?.weekday}` : ' ohne Tag'}`}>+ eintragen</button>;
  async function add() {
    setError(null);
    try {
      const [k, ...rest] = ref.split(':');
      await api('/api/board/items', { method: 'POST', json: ref ? { date, ref: { kind: k, id: rest.join(':') } } : { date, kind, title } });
      setOpen(false); setRef(''); setTitle('');
      await onAdded();
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <div className="mt-auto grid gap-1 rounded border border-line p-1.5 text-[11px]">
      <Field label="Aus deinem Material" htmlFor={`add-ref-${date ?? 'none'}`}>
        <select id={`add-ref-${date ?? 'none'}`} className="field py-0.5 text-[11px]" value={ref} onChange={(e) => setRef(e.target.value)}>
          <option value="">– eigene Idee –</option>
          {free.map((m) => <option key={m.ref} value={m.ref}>{BOARD_KIND_LABEL[m.kind]}: {m.title}</option>)}
        </select>
      </Field>
      {!ref ? (
        <>
          <input aria-label="Titel der Idee" className="field py-0.5 text-[11px]" placeholder="Titel" maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} />
          <select aria-label="Art" className="field py-0.5 text-[11px]" value={kind} onChange={(e) => setKind(e.target.value as BoardKind)}>
            {(['idea', 'reel', 'carousel', 'story'] as const).map((k) => <option key={k} value={k}>{BOARD_KIND_LABEL[k]}</option>)}
          </select>
        </>
      ) : null}
      <div className="flex gap-1"><Button size="sm" variant="primary" disabled={!ref && !title.trim()} onClick={() => void add()}>Eintragen</Button><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Abbrechen</Button></div>
      <ErrorNote error={error} />
    </div>
  );
}
