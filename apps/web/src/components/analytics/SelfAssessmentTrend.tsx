'use client';
import type { SelfAssessmentList } from '@/lib/types';

type Week = SelfAssessmentList['series'][number];
const W = 560, H = 150, PAD = { l: 26, r: 12, t: 10, b: 22 };
const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString('de-DE', { maximumFractionDigits: 1 }));

/**
 * Weekly average joy and comfort on camera (same 1–5 scale, one axis) plus finished pieces per week.
 * Neutral ink colours only; comfort is dashed, so the two lines differ without colour. A table repeats the values.
 */
export function SelfAssessmentTrend({ series }: { series: Week[] }) {
  const x = (i: number) => PAD.l + (series.length <= 1 ? 0 : (i * (W - PAD.l - PAD.r)) / (series.length - 1));
  const y = (v: number) => PAD.t + ((5 - v) * (H - PAD.t - PAD.b)) / 4;
  const path = (pick: (w: Week) => number | null) => {
    let d = '';
    let pen = false;
    series.forEach((w, i) => {
      const v = pick(w);
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const any = series.some((w) => w.count > 0);
  return (
    <section className="panel" data-testid="self-assessment-trend">
      <h2 className="mb-1 text-lg font-bold">Verlauf</h2>
      <p className="hint">Wochenschnitt der letzten {series.length} Wochen. Leere Wochen sind einfach leer.</p>
      <div className="mt-2 flex gap-4 text-[11px] text-muted" aria-hidden>
        <span className="flex items-center gap-1.5"><svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke="var(--color-ink, #1f2419)" strokeWidth="2" /></svg>Freude</span>
        <span className="flex items-center gap-1.5"><svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke="#8a917f" strokeWidth="2" strokeDasharray="4 3" /></svg>Sicherheit vor der Kamera</span>
      </div>
      {any ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-auto w-full" role="img" aria-label="Verlauf Freude und Sicherheit vor der Kamera pro Woche (Werte in der Tabelle darunter)">
          {[1, 2, 3, 4, 5].map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#e6e9df" strokeWidth="1" />
              <text x={PAD.l - 8} y={y(v) + 3} fontSize="9" textAnchor="end" fill="#8a917f">{v}</text>
            </g>
          ))}
          <path d={path((w) => w.joyAvg)} fill="none" stroke="var(--color-ink, #1f2419)" strokeWidth="2" strokeLinejoin="round" />
          <path d={path((w) => w.comfortAvg)} fill="none" stroke="#8a917f" strokeWidth="2" strokeDasharray="4 3" strokeLinejoin="round" />
          {series.map((w, i) => (
            <g key={w.week}>
              {w.joyAvg != null ? <circle cx={x(i)} cy={y(w.joyAvg)} r="4" fill="var(--color-ink, #1f2419)" stroke="#fff" strokeWidth="2"><title>{`${w.week}: Freude Ø ${fmt(w.joyAvg)}`}</title></circle> : null}
              {w.comfortAvg != null ? <circle cx={x(i)} cy={y(w.comfortAvg)} r="4" fill="#8a917f" stroke="#fff" strokeWidth="2"><title>{`${w.week}: Kamera Ø ${fmt(w.comfortAvg)}`}</title></circle> : null}
              {i % 2 === series.length % 2 || series.length <= 6 ? <text x={x(i)} y={H - 6} fontSize="9" textAnchor="middle" fill="#8a917f">{w.week.slice(5)}</text> : null}
            </g>
          ))}
        </svg>
      ) : <p className="hint mt-3">Noch keine Einträge in diesem Zeitraum.</p>}
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted">Als Tabelle</summary>
        <table className="mt-2 w-full text-left" data-testid="trend-table">
          <thead className="text-[10px] text-muted"><tr><th className="py-1">Woche</th><th>Einträge</th><th>Sessions</th><th>Fertig</th><th>Freude Ø</th><th>Kamera Ø</th></tr></thead>
          <tbody>
            {series.map((w) => (
              <tr key={w.week} className="border-t border-line"><td className="py-1">{w.week}</td><td>{w.count}</td><td>{w.sessions}</td><td>{w.finished}</td><td>{fmt(w.joyAvg)}</td><td>{fmt(w.comfortAvg)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
      <p className="hint mt-2">Fertige Stücke in diesem Zeitraum: {series.reduce((n, w) => n + w.finished, 0)}.</p>
    </section>
  );
}
