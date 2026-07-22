"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders agent output as pretty markdown (bold, headings, lists, code, tables)
 * styled to the app's design tokens. Safe for streaming/partial markdown. */
function MarkdownImpl({ children, className = "" }: { children: string; className?: string }) {
  // Strip HTML comments (e.g. the plan-mode `<!--decisions …-->` block the UI
  // parses separately) so they never surface as raw text in the transcript.
  const text = children.replace(/<!--[\s\S]*?-->/g, "");
  return (
    <div className={`nx-md text-[15px] leading-[1.7] text-charcoal ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-2 mt-4 text-[19px] font-semibold tracking-[-0.01em] text-charcoal first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-4 text-[17px] font-semibold tracking-[-0.01em] text-charcoal first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 mt-3.5 text-[15px] font-semibold text-charcoal first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="mb-1.5 mt-3 text-[14px] font-semibold text-charcoal first:mt-0">{children}</h4>,
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-charcoal">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-sapphire-link underline underline-offset-2 hover:opacity-80">{children}</a>,
          ul: ({ children }) => <ul className="mb-3 ml-1 list-disc space-y-1 pl-4 last:mb-0 marker:text-pebble">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 ml-1 list-decimal space-y-1 pl-4 last:mb-0 marker:text-pebble">{children}</ol>,
          li: ({ children }) => <li className="pl-1 leading-[1.6]">{children}</li>,
          blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-line-strong pl-3.5 text-bark-grey">{children}</blockquote>,
          hr: () => <hr className="my-4 border-line" />,
          code: ({ className, children }) => {
            const inline = !className?.includes("language-");
            if (inline) {
              return <code className="rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[0.86em] text-charcoal">{children}</code>;
            }
            return <code className={`${className ?? ""} font-mono text-[13px] leading-[1.6]`}>{children}</code>;
          },
          pre: ({ children }) => <pre className="scroll-thin my-3 overflow-x-auto rounded-xl border border-line bg-[#faf9f7] p-3.5 text-[13px]">{children}</pre>,
          table: ({ children }) => <div className="scroll-thin my-3 overflow-x-auto"><table className="w-full border-collapse text-[13.5px]">{children}</table></div>,
          thead: ({ children }) => <thead className="border-b border-line-strong text-left">{children}</thead>,
          th: ({ children }) => <th className="px-3 py-1.5 font-semibold text-charcoal">{children}</th>,
          td: ({ children }) => <td className="border-b border-line px-3 py-1.5 text-bark-grey">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
