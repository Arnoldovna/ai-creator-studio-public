import { route } from '@/server/http';
import { exportWeek } from '@/server/services/board';

/** Etappe 20: the week as a list (`format=txt`) or as all-day calendar entries without alarms (`format=ics`). */
export const GET = route(async (req) => {
  const format = req.nextUrl.searchParams.get('format') === 'ics' ? 'ics' : 'txt';
  const f = await exportWeek(req.nextUrl.searchParams.get('week'), format);
  return new Response(f.body, { headers: { 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
});
