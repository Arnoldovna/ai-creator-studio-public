import { scriptToMarkdown } from '@studio/core';
import { download, route } from '@/server/http';
import { getScript } from '@/server/services/content';

export const GET = route<{ id: string }>(async (req, { id }) => {
  const { script, concept } = await getScript(id);
  const kind = req.nextUrl.searchParams.get('format') === 'md' ? 'md' : 'json';
  const body = kind === 'md'
    ? scriptToMarkdown(concept?.body.title ?? 'Skript', script.version, script.body)
    : JSON.stringify({ conceptTitle: concept?.body.title, ...script }, null, 2);
  return download(body, `ugc-script-v${script.version}.${kind}`, kind);
});
