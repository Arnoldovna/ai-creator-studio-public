'use client';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Safe Markdown renderer for her documents (untrusted text): GitHub tables and lists, no raw HTML (`skipHtml`),
 * no images (an external image would be a request to a third party; the alt text is shown instead), links open in
 * a new tab without referrer. react-markdown's default URL check drops `javascript:` and similar links.
 */
const components: Components = {
  img: ({ alt }) => <span className="text-muted">[Bild: {alt || 'ohne Beschreibung'}]</span>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
};

export function MarkdownView({ markdown, testId }: { markdown: string; testId?: string }) {
  return (
    <div className="md-view" data-testid={testId}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{markdown}</ReactMarkdown>
    </div>
  );
}
