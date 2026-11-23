import { styleBibleToMarkdown } from '@studio/core';
import { download, route } from '@/server/http';
import { getStyleVersion } from '@/server/services/style';

export const GET = route<{ id: string }>(async (req, { id }) => {
  const { version: v, voice } = await getStyleVersion(id);
  const kind = req.nextUrl.searchParams.get('format') === 'md' ? 'md' : 'json';
  const slug = v.rules.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'style';
  const body = kind === 'md'
    ? styleBibleToMarkdown(v, voice)
    : JSON.stringify({ ...v.rules, version: v.version, status: v.status, createdAt: v.createdAt, voice: voice ? { version: voice.version, ...voice.rules } : null }, null, 2);
  return download(body, `${slug}-style-bible-v${v.version}.${kind}`, kind);
});
