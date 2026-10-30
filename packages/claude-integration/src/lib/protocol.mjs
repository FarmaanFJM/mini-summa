// Text injected through SessionStart additionalContext, only for sessions whose
// cwd resolves to a registered project. No repository CLAUDE.md is touched.
export const PROTOCOL_VERSION = 1;
export const REPORT_INSTRUCTION = [
  'Mini-Summa report protocol (user-level, applies to this session only).',
  'When you finish an implementation task the user asked for, end that final message with a section titled "## Implementation Report" covering: what changed, which tests you actually ran and their real results, unresolved problems, risks, and recommended next steps.',
  'The very last line of that final message must be exactly this HTML comment, with status complete, partial or blocked as accurate and a short task title:',
  '<!-- mini-summa:report status=complete task="Short task title" -->',
  'Do not add the marker to progress updates, questions, clarifications, or any message that is not the final report of a finished or stopped task.',
  'The marker is only a declaration. Report test results and failures truthfully.',
].join('\n');
