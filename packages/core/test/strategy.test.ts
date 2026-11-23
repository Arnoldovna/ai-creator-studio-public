import { describe, expect, it } from 'vitest';
import { pillarMix, selfAssessmentSeries } from '../src';

describe('pillarMix and selfAssessmentSeries', () => {
  const pillars = [{ id: 'werkstatt', name: 'Werkstatt', targetShare: 45 }, { id: 'alltag', name: 'Alltag & Routinen', targetShare: 55 }];
  const window = { from: '2026-11-01T00:00:00Z', to: '2026-11-30T23:59:59Z' };
  it('counts finished pieces per pillar plus an „ohne Säule“ row, without mutating input', () => {
    const entries = Object.freeze([
      { pillarId: 'werkstatt', finished: true, assessedAt: '2026-11-02T10:00:00Z' },
      { pillarId: 'werkstatt', finished: true, assessedAt: '2026-11-03T10:00:00Z' },
      { pillarId: 'werkstatt', finished: false, assessedAt: '2026-11-03T10:00:00Z' },
      { pillarId: null, finished: true, assessedAt: '2026-11-04T10:00:00Z' },
      { pillarId: 'alltag', finished: true, assessedAt: '2026-10-01T10:00:00Z' },
    ].map((e) => Object.freeze(e)));
    expect(pillarMix(entries, pillars, window)).toEqual([
      { pillarId: 'werkstatt', name: 'Werkstatt', targetShare: 45, count: 2, actualShare: 67 },
      { pillarId: 'alltag', name: 'Alltag & Routinen', targetShare: 55, count: 0, actualShare: 0 },
      { pillarId: null, name: 'ohne Säule', targetShare: null, count: 1, actualShare: 33 },
    ]);
    expect(pillarMix([], pillars, window).every((r) => r.count === 0 && r.actualShare === 0)).toBe(true);
    // a window without entries: zero rows, nothing divided by zero, the input untouched (frozen above)
    const empty = pillarMix(entries, pillars, { from: '2025-01-01T00:00:00Z', to: '2025-01-31T23:59:59Z' });
    expect(empty.map((r) => [r.pillarId, r.count, r.actualShare])).toEqual([['werkstatt', 0, 0], ['alltag', 0, 0], [null, 0, 0]]);
  });
  it('buckets by ISO week, excludes null comfort and counts sessions', () => {
    const s = selfAssessmentSeries([
      { joy: 4, cameraComfort: null, finished: null, assessedAt: '2026-11-16T09:00:00Z', subject: { kind: 'session' } },
      { joy: 2, cameraComfort: 3, finished: true, assessedAt: '2026-11-17T09:00:00Z', subject: { kind: 'edit_plan' } },
      { joy: 5, cameraComfort: 5, finished: true, assessedAt: '2026-11-10T09:00:00Z' },
    ], 2, '2026-11-18T12:00:00Z');
    expect(s).toEqual([
      { week: '2026-W46', start: '2026-11-09', count: 1, sessions: 1, finished: 1, joyAvg: 5, comfortAvg: 5 },
      { week: '2026-W47', start: '2026-11-16', count: 2, sessions: 1, finished: 1, joyAvg: 3, comfortAvg: 3 },
    ]);
  });
});
