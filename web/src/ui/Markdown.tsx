import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function httpsURL(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === 'https:' ? value : undefined } catch { return undefined }
}

export function Markdown({ content }: { content: string }) {
  return <div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} disallowedElements={['img']} urlTransform={(value) => httpsURL(value) ?? ''} components={{
    a: ({ href, children }) => httpsURL(href ?? '') ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  }}>{content}</ReactMarkdown></div>
}
