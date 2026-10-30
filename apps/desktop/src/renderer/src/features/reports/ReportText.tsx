import { useMemo } from 'react';
import { parseReportText } from './model';

export interface ReportTextProps {
  /** The text exactly as stored. It is untrusted: it only ever becomes text nodes, never markup. */
  text: string;
  label?: string;
}

/** Monospace, selectable, formatting kept. Fenced blocks become code blocks; everything else is shown as written. */
export function ReportText({ text, label = 'Full report text' }: ReportTextProps) {
  const segments = useMemo(() => parseReportText(text), [text]);
  return (
    <div className="ms-rep-text ms-mono" role="region" aria-label={label}>
      {segments.length === 0 ? <p className="ms-rep-text__empty">This report has no text.</p> : null}
      {segments.map((segment, i) => (segment.kind === 'text' ? (
        <div key={i} className="ms-rep-prose">{segment.text}</div>
      ) : (
        <figure key={i} className="ms-rep-code">
          {segment.info ? <figcaption className="ms-rep-code__info">{segment.info}</figcaption> : null}
          <pre className="ms-rep-code__pre"><code>{segment.text}</code></pre>
        </figure>
      )))}
    </div>
  );
}
