import { NextResponse, type NextRequest } from 'next/server';
import { checkSameOrigin, safeEqual, SESSION_COOKIE, tokenDigest } from '@/server/auth';

export async function POST(req: NextRequest) {
  const token = process.env.STUDIO_ACCESS_TOKEN;
  if (!token) return NextResponse.json({ error: 'Kein STUDIO_ACCESS_TOKEN konfiguriert – Login nicht nötig.' }, { status: 400 });
  const sameOrigin = checkSameOrigin({ method: req.method, host: req.headers.get('host'), origin: req.headers.get('origin'), secFetchSite: req.headers.get('sec-fetch-site') });
  if (!sameOrigin) return NextResponse.json({ error: 'Cross-Site-Anfrage abgelehnt.' }, { status: 403 });
  const form = await req.formData();
  const given = String(form.get('token') ?? '');
  if (!safeEqual(given, token)) return NextResponse.redirect(new URL('/login?error=1', req.url), 303);
  const res = NextResponse.redirect(new URL('/', req.url), 303);
  res.cookies.set(SESSION_COOKIE, tokenDigest(token), { httpOnly: true, sameSite: 'strict', secure: req.nextUrl.protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 30 });
  return res;
}
