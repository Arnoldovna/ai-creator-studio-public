import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { ProviderError, ValidationError } from '@studio/core';
import { HttpError } from './errors';
import { checkAccess, checkJobToken, checkSameOrigin, SESSION_COOKIE } from './auth';

type Ctx<P> = { params: Promise<P> };

export { HttpError };

export function errorResponse(e: unknown) {
  if (e instanceof ZodError) {
    return NextResponse.json({ error: 'Validierung fehlgeschlagen', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, { status: 400 });
  }
  if (e instanceof ProviderError) return NextResponse.json({ error: e.message, retryable: e.retryable }, { status: 502 });
  if (e instanceof HttpError) return NextResponse.json(e.code ? { error: e.message, code: e.code } : { error: e.message }, { status: e.status });
  if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error(e);
  return NextResponse.json({ error: 'Interner Fehler' }, { status: 500 });
}

/** Authenticated route handler wrapper (UI/API access). */
export function route<P = Record<string, never>>(handler: (req: NextRequest, params: P) => Promise<Response | unknown>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    const access = checkAccess({
      host: req.headers.get('host'),
      cookie: req.cookies.get(SESSION_COOKIE)?.value,
      authorization: req.headers.get('authorization'),
    });
    if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 401 });
    const sameOrigin = checkSameOrigin({
      method: req.method,
      host: req.headers.get('host'),
      origin: req.headers.get('origin'),
      secFetchSite: req.headers.get('sec-fetch-site'),
    });
    if (!sameOrigin) return NextResponse.json({ error: 'Cross-Site-Anfrage abgelehnt.' }, { status: 403 });
    try {
      const out = await handler(req, await ctx.params);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** Workflow route wrapper: n8n → app, bearer STUDIO_JOB_TOKEN. */
export function jobRoute(handler: (req: NextRequest) => Promise<unknown>) {
  return async (req: NextRequest) => {
    const auth = checkJobToken(req.headers.get('authorization'));
    if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: auth.status });
    try {
      return NextResponse.json(await handler(req));
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function jsonBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'Ungültiges JSON');
  }
}

/** File download response (Markdown or JSON) with a sanitized filename. */
export function download(body: string, filename: string, kind: 'md' | 'json') {
  const safe = filename.replace(/[^\w.-]+/g, '-');
  return new Response(body, {
    headers: {
      'Content-Type': kind === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safe}"`,
    },
  });
}
