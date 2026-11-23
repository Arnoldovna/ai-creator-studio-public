'use client';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatApplyResult } from '@/lib/types';
import { ChatPanel } from './ChatPanel';

/**
 * Studio-Chat as a command line on every page (Etappe 15, „Ein Satz an Claude ändert alles“): one panel, opened with
 * ⌘K / Strg+K or the button. A page registers its scope (`brand`, `strategy`, `editor:<projectId>`) and hooks:
 * `beforeSend` (the editor saves its draft first, so the chat sees what she sees) and `onApplied` (reload after
 * „Übernehmen“). Without a registration the scope follows the path (Meine Marke, Strategie, else Allgemein).
 */
export interface ChatScopeReg {
  scope: string;
  label: string;
  /** Editor: the base of the draft (null = Freier Schnitt). */
  scriptId?: string | null;
  /** Etappe 20: the week the board shows (the chat's week patch works on it). */
  weekStart?: string | null;
  beforeSend?: () => Promise<void>;
  onApplied?: (r: ChatApplyResult) => void | Promise<void>;
}

interface ChatCtx { open: boolean; setOpen: (v: boolean | ((o: boolean) => boolean)) => void; register: (r: ChatScopeReg) => () => void; current: ChatScopeReg }
const Ctx = createContext<ChatCtx | null>(null);

const fromPath = (path: string): ChatScopeReg =>
  path.startsWith('/meine-marke') ? { scope: 'brand', label: 'Meine Marke' } : path.startsWith('/strategy') ? { scope: 'strategy', label: 'Strategie' } : path.startsWith('/woche') ? { scope: 'week', label: 'Wochenboard' } : { scope: 'general', label: 'Allgemein' };

export function ChatProvider({ children, mock }: { children: ReactNode; mock: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [regs, setRegs] = useState<{ id: number; reg: ChatScopeReg }[]>([]);
  const nextId = useRef(0);
  const register = useCallback((reg: ChatScopeReg) => {
    const id = ++nextId.current;
    setRegs((r) => [...r.filter((x) => x.reg.scope !== reg.scope), { id, reg }]);
    return () => setRegs((r) => r.filter((x) => x.id !== id));
  }, []);
  const current = regs[regs.length - 1]?.reg ?? fromPath(path);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        setOpen((o) => !o);
      }
    };
    // capture: the editor's own shortcuts (K = pause) never see ⌘K
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const value = useMemo(() => ({ open, setOpen, register, current }), [open, register, current]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} data-testid="chat-launcher" aria-keyshortcuts="Meta+K Control+K"
          className="fixed right-5 bottom-5 z-40 flex items-center gap-2 rounded-full border border-line bg-card px-4 py-2.5 text-xs font-medium shadow-lg hover:bg-[#f2f4ec]">
          <span aria-hidden>✦</span> Chat · {current.label}<kbd className="rounded border border-line px-1 font-mono text-[10px] text-muted">⌘K</kbd>
        </button>
      ) : null}
      {open ? <ChatPanel reg={current} mock={mock} onClose={() => setOpen(false)} /> : null}
    </Ctx.Provider>
  );
}

export function useChat() {
  const c = useContext(Ctx);
  return { open: () => c?.setOpen(true), isOpen: c?.open ?? false };
}

/**
 * Registers the page's chat scope while mounted. Callbacks are read through a ref, so a re-render does not re-register
 * (and does not reset the panel).
 */
export function useChatScope(reg: ChatScopeReg | null) {
  const c = useContext(Ctx);
  const ref = useRef(reg);
  useEffect(() => { ref.current = reg; });
  const scope = reg?.scope ?? null, label = reg?.label ?? '', scriptId = reg?.scriptId, weekStart = reg?.weekStart;
  useEffect(() => {
    if (!c || !scope) return;
    return c.register({
      scope, label, scriptId, weekStart,
      beforeSend: () => ref.current?.beforeSend?.() ?? Promise.resolve(),
      onApplied: (r) => ref.current?.onApplied?.(r),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `c.register` is stable; callbacks go through the ref
  }, [scope, label, scriptId, weekStart]);
}

/** A page button that opens the chat (same panel as ⌘K). */
export function ChatButton({ className = '' }: { className?: string }) {
  const { open } = useChat();
  return (
    <button type="button" onClick={open} data-testid="chat-open" className={`inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-xs font-medium hover:bg-[#f2f4ec] ${className}`}>
      <span aria-hidden>✦</span> Mit dem Studio sprechen <kbd className="font-mono text-[10px] text-muted">⌘K</kbd>
    </button>
  );
}
