// Text injected through SessionStart additionalContext, only for sessions whose
// cwd resolves to a registered project. No repository CLAUDE.md is touched.
export const PROTOCOL_VERSION = 1;
export const REPORT_INSTRUCTION = [
  'Mini-Summa report protocol (user-level, applies to this session only).',
  'Whenever you finish, or have to stop, a task the user gave you, however small (for example you created or changed a file, or ran commands for them), end that final message with a section titled "## Implementation Report". For a small task two or three lines are enough. For a larger one cover what changed, which tests you actually ran and their real results, unresolved problems, risks, and recommended next steps.',
  'The very last line of that final message must be exactly this HTML comment, with status complete, partial or blocked as accurate and a short task title:',
  '<!-- mini-summa:report status=complete task="Short task title" -->',
  'Do not add the marker to progress updates, questions, clarifications, or answers to a request that did not ask you to do anything.',
  'The marker is only a declaration. Report test results and failures truthfully.',
].join('\n');
