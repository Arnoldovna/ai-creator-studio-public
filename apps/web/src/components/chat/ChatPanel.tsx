'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_CHAT_IMAGES, PATCH_KIND_LABEL } from '@studio/core/studioChat';
import { api, ApiError } from '@/lib/api';
import type { ChatApplyResult, ChatMessageView, ChatProposalView, ChatThreadList, ChatThreadView, ReferenceWithAnalysis } from '@/lib/types';
import { SlopHints } from '../SlopHints';
import { useToast } from '../toast';
import { Button, ErrorNote, fmtDateTime, Pill } from '../ui';
import type { ChatScopeReg } from './ChatProvider';

const usd = (x: number | null | undefined) => (x == null ? '—' : x === 0 ? '0 $' : `${x < 0.01 ? x.toFixed(4) : x.toFixed(3)} $`);

/**
 * The chat side panel (Etappe 15). No streaming: one request per message (5–15 s with a real model). Proposals are
 * cards with before/after and „Übernehmen“ / „Verwerfen“; nothing changes without that click. Mock answers are
 * marked MOCK. History per page scope.
 */
export function ChatPanel({ reg, mock, onClose }: { reg: ChatScopeReg; mock: boolean; onClose: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<ChatThreadList | null>(null);
  const [thread, setThread] = useState<ChatThreadView | null>(null);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [refs, setRefs] = useState<ReferenceWithAnalysis[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const loadList = useCallback(async () => {
    const l = await api<ChatThreadList>(`/api/chat/threads?scope=${encodeURIComponent(reg.scope)}`);
    setList(l);
    return l;
  }, [reg.scope]);
  const loadThread = useCallback(async (id: string) => setThread(await api<ChatThreadView>(`/api/chat/threads/${id}/messages`)), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const l = await loadList();
        if (cancelled) return;
        if (l.threads[0]) await loadThread(l.threads[0].id);
        else setThread(null);
      } catch (e) { setErr((e as Error).message); }
    })();
    inputRef.current?.focus();
    return () => { cancelled = true; };
  }, [loadList, loadThread]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread, pending]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function send() {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy('send'); setErr(null); setPending(msg);
    try {
      await reg.beforeSend?.();
      const id = thread?.thread.id ?? (await api<{ id: string }>('/api/chat/threads', { method: 'POST', json: { scope: reg.scope } })).id;
      setText(''); setImages([]);
      await api(`/api/chat/threads/${id}/messages`, { method: 'POST', json: { text: msg, imageIds: images, scriptId: reg.scriptId ?? null, ...(reg.weekStart ? { weekStart: reg.weekStart } : {}) } });
      await loadThread(id);
      await loadList();
    } catch (e) {
      setErr((e as Error).message);
      setText(msg);
      const id = thread?.thread.id;
      if (id) await loadThread(id).catch(() => undefined);
      else await loadList().then((l) => (l.threads[0] ? loadThread(l.threads[0].id) : undefined)).catch(() => undefined);
    } finally {
      setBusy(null); setPending(null);
    }
  }

  async function decide(p: ChatProposalView, action: 'apply' | 'dismiss') {
    setBusy(`${action}-${p.id}`); setErr(null);
    try {
      if (action === 'apply') {
        await reg.beforeSend?.();
        const r = await api<ChatApplyResult>(`/api/chat/proposals/${p.id}/${action}`, { method: 'POST' });
        await reg.onApplied?.(r);
        toast(r.kind === 'edit_draft' || r.kind === 'story' ? `Übernommen – Entwurf Stand ${r.result.revision} (⌘Z macht es rückgängig).` : `Übernommen – neue aktive Version v${r.result.version} (die vorige bleibt in der Historie).`);
      } else await api(`/api/chat/proposals/${p.id}/${action}`, { method: 'POST' });
      if (thread) await loadThread(thread.thread.id);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 ? `${e.message}` : (e as Error).message);
      if (thread) await loadThread(thread.thread.id).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  async function newThread() {
    setErr(null);
    const t = await api<{ id: string }>('/api/chat/threads', { method: 'POST', json: { scope: reg.scope } });
    await loadList();
    await loadThread(t.id);
    inputRef.current?.focus();
  }

  async function pinModel(modelId: string | null) {
    try {
      await api('/api/eval/preferences', { method: 'PUT', json: { useCase: 'studio_chat', modelId } });
      await loadList();
      toast(modelId ? 'Modell für den Chat festgelegt.' : 'Chat-Modell wieder automatisch (Router).');
    } catch (e) { setErr((e as Error).message); }
  }

  async function openPicker() {
    setPicking((v) => !v);
    if (!refs) setRefs((await api<ReferenceWithAnalysis[]>('/api/references').catch(() => [])).filter((r) => r.kind === 'image'));
  }

  const model = list?.model;
  const messages = thread?.messages ?? [];
  return (
    <aside role="dialog" aria-label={`Studio-Chat · ${reg.label}`} data-testid="chat-panel"
      className="fixed top-0 right-0 z-40 flex h-screen w-full flex-col border-l border-line bg-card shadow-2xl sm:w-[440px]">
      <header className="border-b border-line p-3">
        <div className="flex items-center gap-2">
          <strong className="text-sm">Studio-Chat</strong>
          <Pill>{reg.label}</Pill>
          <span className="ml-auto" />
          <Button size="sm" variant="ghost" onClick={() => void newThread()} data-testid="chat-new">Neuer Verlauf</Button>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Chat schließen (Esc)">✕</Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]" data-testid="chat-model">
          {model ? (
            <>
              <Pill tone={model.mode === 'mock' ? 'mock' : 'default'}>{model.label}</Pill>
              <span className="text-muted" title="geschätzt je Nachricht; die echten Kosten stehen an jeder Antwort">≈ {usd(model.estCostUsd)} je Nachricht{model.worstCaseUsd ? ` (höchstens ${usd(model.worstCaseUsd)})` : ''}</span>
              {model.mode === 'routed' ? (
                <select aria-label="Modell für den Chat" className="field ml-auto w-auto py-1 text-[11px]" value={model.pinned ?? ''} onChange={(e) => void pinModel(e.target.value || null)}>
                  <option value="">Automatisch (Router)</option>
                  {model.options.map((o) => <option key={o.id} value={o.id}>{o.label} · ≈ {usd(o.estCostUsd)}</option>)}
                </select>
              ) : null}
            </>
          ) : <span className="text-muted">Lade …</span>}
        </div>
        {mock || model?.mode === 'mock' ? <p className="mt-2 mb-0 rounded-md border border-[#e8cf7a] bg-[#fff6db] px-2 py-1 text-[11px] text-warn" data-testid="chat-mock-note">MOCK-Modus: regelbasierte Antworten ohne KI. Es versteht nur einfache Sätze.</p> : null}
        {list?.confidential ? <p className="mt-2 mb-0 text-[11px] text-muted">Kundenprojekt: vertrauliches Routing, kein persönlicher Kontext.</p> : null}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3" data-testid="chat-messages">
        {!messages.length && !pending ? (
          <div className="rounded-lg border border-dashed border-line p-3 text-xs leading-relaxed text-muted">
            Ein Satz genügt, z. B. {reg.scope === 'brand' ? '„mach den Akzent wärmer“' : reg.scope.startsWith('editor:') ? '„Keyword ‚Ruhe‘ bei 3 s“ oder „Satz 2 schneiden“' : reg.scope === 'strategy' ? '„Fernziel: Brand Deals mit Wollmarken“' : '„mach den Akzent wärmer“'}.
            Du bekommst Vorschläge – erst „Übernehmen“ ändert etwas. Renders, bezahlte Jobs und Posten startest du selbst.
          </div>
        ) : null}
        <ul className="grid gap-3">
          {messages.map((m) => <MessageItem key={m.id} m={m} busy={busy} onDecide={decide} />)}
          {pending ? (
            <li className="grid gap-2" aria-live="polite">
              <div className="ml-auto max-w-[85%] rounded-xl bg-lime px-3 py-2 text-xs whitespace-pre-wrap text-olive-ink">{pending}</div>
              <div className="text-[11px] text-muted" data-testid="chat-thinking">Antwort kommt … (ohne Streaming, mit echtem Modell 5–15 s)</div>
            </li>
          ) : null}
        </ul>
      </div>

      <footer className="border-t border-line p-3">
        <ErrorNote error={err} />
        {images.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5" data-testid="chat-images">
            {images.map((id) => (
              <button key={id} type="button" onClick={() => setImages((x) => x.filter((y) => y !== id))} title="Entfernen" className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- private media route */}
                <img src={`/api/media/${id}`} alt="Angehängtes Referenzbild" className="h-12 w-12 rounded object-cover" />
                <span className="absolute -top-1 -right-1 rounded-full bg-card px-1 text-[10px]">✕</span>
              </button>
            ))}
          </div>
        ) : null}
        {picking ? (
          <div className="mb-2 max-h-40 overflow-y-auto rounded-lg border border-line p-2" data-testid="chat-image-picker">
            {refs == null ? <p className="hint m-0">Lade Referenzen …</p> : !refs.length ? <p className="hint m-0">Keine Bild-Referenzen in deiner Bibliothek.</p> : (
              <div className="grid grid-cols-5 gap-1.5">
                {refs.map((r) => {
                  const on = images.includes(r.id);
                  return (
                    <button key={r.id} type="button" aria-pressed={on} disabled={!on && images.length >= MAX_CHAT_IMAGES} title={r.name}
                      onClick={() => setImages((x) => (on ? x.filter((y) => y !== r.id) : [...x, r.id]))}
                      className={`rounded border-2 ${on ? 'border-accent' : 'border-transparent'} disabled:opacity-40`}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- private media route */}
                      <img src={`/api/media/${r.id}`} alt={r.name} className="aspect-square w-full rounded object-cover" />
                    </button>
                  );
                })}
              </div>
            )}
            <p className="hint mt-1 mb-0">Höchstens {MAX_CHAT_IMAGES} Bilder; sie gehen als Daten an das Modell.</p>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea ref={inputRef} rows={2} className="field flex-1 resize-none text-[13px]" placeholder="Sag dem Studio, was es vorschlagen soll …" aria-label="Nachricht an das Studio"
            data-testid="chat-input" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          <div className="grid gap-1">
            <Button size="sm" variant="ghost" onClick={() => void openPicker()} aria-expanded={picking} data-testid="chat-attach">Bild ({images.length}/{MAX_CHAT_IMAGES})</Button>
            <Button size="sm" variant="primary" busy={busy === 'send'} disabled={!text.trim()} onClick={() => void send()} data-testid="chat-send">Senden</Button>
          </div>
        </div>
        <p className="hint mt-1 mb-0">Enter sendet · Shift+Enter neue Zeile · ⌘K / Strg+K öffnet und schließt.</p>
      </footer>
    </aside>
  );
}

function MessageItem({ m, busy, onDecide }: { m: ChatMessageView; busy: string | null; onDecide: (p: ChatProposalView, a: 'apply' | 'dismiss') => void }) {
  if (m.role === 'user') {
    return (
      <li className="ml-auto max-w-[85%]" data-testid="chat-user-message">
        <div className="rounded-xl bg-lime px-3 py-2 text-xs whitespace-pre-wrap text-olive-ink">{m.text}</div>
        {m.imageIds.length ? <div className="mt-1 text-right text-[10px] text-muted">{m.imageIds.length} Bild(er) angehängt</div> : null}
      </li>
    );
  }
  return (
    <li className="grid gap-2" data-testid="chat-assistant-message">
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted">
        {m.mock ? <Pill tone="mock">MOCK · kein LLM</Pill> : <Pill>{m.model ?? m.provider}</Pill>}
        <span title={m.costSource ?? undefined}>{m.mock ? 'kostenlos' : `Kosten ${usd(m.costUsd)}${m.costSource === 'worst_case' ? ' (Obergrenze)' : ''}`}</span>
        <span>{fmtDateTime(m.createdAt)}</span>
      </div>
      <div className="rounded-xl border border-line bg-card2 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">{m.text}</div>
      <SlopHints hints={m.lint} testId="chat-reply-lint" />
      {m.warnings.length ? <ul className="m-0 grid gap-0.5 text-[11px] text-warn">{m.warnings.map((w, i) => <li key={i}>• {w}</li>)}</ul> : null}
      {m.proposals.map((p) => <ProposalCard key={p.id} p={p} busy={busy} onDecide={onDecide} />)}
    </li>
  );
}

const Swatch = ({ hex }: { hex: string }) => <span className="inline-block h-5 w-5 rounded border border-black/15 align-middle" style={{ background: /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : '#ccc' }} title={hex} />;

function ProposalCard({ p, busy, onDecide }: { p: ChatProposalView; busy: string | null; onDecide: (p: ChatProposalView, a: 'apply' | 'dismiss') => void }) {
  return (
    <div className="rounded-xl border border-line bg-card p-3 text-xs" data-testid="chat-proposal">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong>{p.title}</strong>
        <Pill>{PATCH_KIND_LABEL[p.kind]}</Pill>
        {p.status === 'applied' ? <Pill tone="ok">übernommen{p.result?.version ? ` · v${p.result.version}` : p.result?.revision ? ` · Stand ${p.result.revision}` : ''}</Pill> : null}
        {p.status === 'dismissed' ? <Pill>verworfen</Pill> : null}
      </div>
      <ul className="m-0 grid gap-1.5">
        {p.changes.map((c, i) => (
          <li key={i} data-testid="chat-change">
            <div className="text-[10px] font-semibold tracking-wide text-muted uppercase">{c.label}</div>
            {c.kind === 'color' ? (
              <div className="flex items-center gap-2 font-mono" data-testid="chat-color-change">
                <Swatch hex={c.before} /> {c.before} <span aria-hidden>→</span> <Swatch hex={c.after} /> <strong>{c.after}</strong>
              </div>
            ) : (
              <div className="grid gap-0.5">
                {c.before !== '–' ? <del className="text-muted">{c.before}</del> : null}
                <ins className="no-underline">{c.after}</ins>
              </div>
            )}
          </li>
        ))}
      </ul>
      {p.warnings.length ? <ul className="mt-2 mb-0 grid gap-0.5 text-[11px] text-warn">{p.warnings.map((w, i) => <li key={i}>• {w}</li>)}</ul> : null}
      <SlopHints hints={p.lint} testId="chat-proposal-lint" />
      {p.status === 'open' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {p.stale ? <span className="text-[11px] text-warn" data-testid="chat-stale">Inzwischen geändert – bitte neu vorschlagen lassen.</span> : null}
          <Button size="sm" variant="primary" busy={busy === `apply-${p.id}`} disabled={!!busy || p.stale} onClick={() => onDecide(p, 'apply')} data-testid="chat-apply">Übernehmen</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => onDecide(p, 'dismiss')} data-testid="chat-dismiss">Verwerfen</Button>
        </div>
      ) : null}
    </div>
  );
}
