// The message handed to ChatGPT, and its lossless split into pasteable parts.
//
// The report body is placed verbatim between unique fences. Nothing is summarized, trimmed or re-wrapped. If a message
// is too long to paste at once it is split into parts whose payloads concatenate back to exactly the original message.
import type { DeclaredStatus } from './entities.ts';

export const DEFAULT_REVIEW_REQUEST = [
  'Please review this implementation report as the reviewer for this project.',
  'Say what looks wrong, risky or untested, and what Claude should do next.',
  'If Claude should receive follow-up instructions, write them so I can paste them in unchanged.',
].join('\n');

export interface ReportMessageInput {
  reportId: string;
  projectName: string;
  taskTitle: string;
  /** For example "a1b2c3d4, managed, Windows, generation 1". */
  sessionRef: string;
  declaredStatus: DeclaredStatus;
  capturedAt: string;
  body: string;
  /** Null leaves the review request out. */
  reviewRequest: string | null;
  includeSessionRef?: boolean;
}

export const fenceBegin = (reportId: string) => `<<<MINI-SUMMA REPORT ${reportId} BEGIN>>>`;
export const fenceEnd = (reportId: string) => `<<<MINI-SUMMA REPORT ${reportId} END>>>`;

export function buildReportMessage(input: ReportMessageInput): string {
  const lines = [
    `Project: ${input.projectName}`,
    `Task: ${input.taskTitle}`,
  ];
  if (input.includeSessionRef !== false) lines.push(`Claude session: ${input.sessionRef}`);
  lines.push(
    `Captured: ${input.capturedAt}`,
    `Status declared by Claude: ${input.declaredStatus} (a declaration by the model, not verified)`,
    '',
    'The full report from Claude Code follows, unedited.',
    fenceBegin(input.reportId),
    input.body,
    fenceEnd(input.reportId),
  );
  if (input.reviewRequest && input.reviewRequest.trim() !== '') lines.push('', input.reviewRequest.trim());
  return lines.join('\n');
}

export interface MessagePart {
  index: number; // 1-based
  total: number;
  /** Exactly what to paste: payload plus the part header and footer. */
  text: string;
  /** The slice of the original message this part carries. Concatenating all payloads restores the message. */
  payload: string;
}

const headerFor = (reportId: string, i: number, n: number) => `[Mini-Summa report ${reportId.slice(0, 8)}, part ${i} of ${n}]\n`;
const footerFor = (i: number, n: number) => (i < n
  ? `\n[End of part ${i} of ${n}. More parts follow. Do not answer yet.]`
  : `\n[End of part ${n} of ${n}. That was the complete report.]`);

/** Index just before a UTF-16 surrogate pair would be cut in half. */
function safeCut(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const prev = text.charCodeAt(cut - 1);
  return prev >= 0xd800 && prev <= 0xdbff ? cut - 1 : cut;
}

export function splitMessage(message: string, reportId: string, maxChars: number): MessagePart[] {
  const limit = Math.max(2000, Math.floor(maxChars));
  if (message.length <= limit) return [{ index: 1, total: 1, text: message, payload: message }];
  // Reserve room for the header and footer (generous: the numbers can grow by a digit or two).
  const overhead = headerFor(reportId, 99, 99).length + footerFor(1, 99).length + 8;
  const budget = limit - overhead;
  const payloads: string[] = [];
  let pos = 0;
  while (pos < message.length) {
    let end = Math.min(message.length, pos + budget);
    if (end < message.length) {
      // Prefer a line break in the second half of the window, then a space, then a hard cut.
      const window = message.slice(pos, end);
      const nl = window.lastIndexOf('\n');
      if (nl > budget * 0.5) end = pos + nl + 1;
      else {
        const sp = window.lastIndexOf(' ');
        if (sp > budget * 0.8) end = pos + sp + 1;
      }
      end = safeCut(message, end);
      if (end <= pos) end = pos + Math.max(1, budget); // pathological window
    }
    payloads.push(message.slice(pos, end));
    pos = end;
  }
  const total = payloads.length;
  return payloads.map((payload, k) => ({
    index: k + 1,
    total,
    payload,
    text: `${headerFor(reportId, k + 1, total)}${payload}${footerFor(k + 1, total)}`,
  }));
}

export const joinPayloads = (parts: MessagePart[]): string => [...parts].sort((a, b) => a.index - b.index).map((p) => p.payload).join('');
