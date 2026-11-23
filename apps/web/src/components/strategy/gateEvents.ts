'use client';
import { useEffect } from 'react';

/**
 * Several gate views can show the same piece (two plan versions of one script, copy + storyboard + script of one
 * concept). A FitCheck save or an override changes the shared gate, so every open view reloads its blockers;
 * otherwise a sibling's „Freigeben“ stays disabled until a page reload. The server enforces the gate either way.
 */
const EVENT = 'studio:strategy-gate-changed';

/** `source` lets the sender skip its own reload (a FitCheck with saves in flight keeps its newest answer). */
export function announceGateChange(source?: string) {
  window.dispatchEvent(new CustomEvent<string | undefined>(EVENT, { detail: source }));
}

export function useGateChanges(reload: () => unknown, self?: string) {
  useEffect(() => {
    const onChange = (e: Event) => {
      if (self && (e as CustomEvent<string | undefined>).detail === self) return;
      void reload();
    };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, [reload, self]);
}
