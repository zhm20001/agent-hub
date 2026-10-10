import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownBodyProps {
  /** Markdown source (GFM). */
  source: string;
  className?: string;
}

/**
 * Light GFM markdown renderer for last-turn / assistant bubbles (tables, headings).
 */
export const MarkdownBody: React.FC<MarkdownBodyProps> = ({ source, className }) => {
  return (
    <div className={className ? `ah-md ${className}` : 'ah-md'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
};
