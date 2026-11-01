import type { ClaudeWebViewState, CloudSessionRecord, Project } from '@minisumma/shared';
import { Button, Icon } from '../../ui';

export interface CloudFallbackProps {
  project: Pick<Project, 'githubRepo'>;
  view: ClaudeWebViewState;
  sessions: CloudSessionRecord[];
  /** The session page the tab was on, when it was one. */
  currentUrl: string | null;
  onRetry: () => void;
  onOpenBrowser: (url: string) => void;
  onCopyLink: (url: string) => void;
  onNewTask: () => void;
  onTemporary: () => void;
  onShowAnyway: () => void;
  onOpenSession: (url: string) => void;
  onFollowUp: (record: CloudSessionRecord) => void;
}

const WHY: Record<'blocked' | 'error' | 'stalled' | 'blank', string> = {
  blocked: 'Claude Code on the web did not open in this window.',
  error: 'Claude Code on the web could not be loaded.',
  stalled: 'Claude Code on the web is taking too long to load.',
  blank: 'Claude Code on the web loaded but the page looks empty.',
};

/**
 * Shown instead of an empty panel when the embedded page cannot be shown. It says what failed, and everything that does not need the
 * page still works: starting a task through the CLI, opening or copying a session link, and running Claude locally.
 */
export function CloudFallback(p: CloudFallbackProps) {
  const status = p.view.status === 'blocked' || p.view.status === 'error' || p.view.status === 'stalled' || p.view.status === 'blank' ? p.view.status : 'error';
  const recent = p.sessions.slice(0, 5);
  const target = p.currentUrl ?? recent[0]?.url ?? null;
  return (
    <div className="ms-cloud__fallback" role="region" aria-label="Claude Code on the web is not showing">
      <div className="ms-cloud__fallback-inner">
        <p className="ms-cloud__why"><Icon name="circle-alert" /> {WHY[status]}</p>
        {p.view.note ? <p className="ms-cloud__line">{p.view.note}</p> : null}
        {p.project.githubRepo ? <p className="ms-cloud__line">Repository <span className="ms-mono">{p.project.githubRepo}</span>. Starting a task from Mini-Summa does not need this page.</p> : null}
        <div className="ms-cloud__actions">
          <Button variant="primary" icon="cloud" onClick={p.onNewTask}>New cloud task</Button>
          <Button icon="terminal" onClick={p.onTemporary}>Temporary local session</Button>
          <Button icon="refresh" onClick={p.onRetry}>Retry</Button>
          <Button icon="external" onClick={() => p.onOpenBrowser(target ?? 'https://claude.ai/code')}>Open in your browser</Button>
          {target ? <Button icon="copy" onClick={() => p.onCopyLink(target)}>Copy session link</Button> : null}
          {status === 'blank' || status === 'stalled' ? <Button variant="ghost" onClick={p.onShowAnyway}>Show the page anyway</Button> : null}
        </div>
        {recent.length > 0 ? (
          <div className="ms-cloud__recent">
            <p className="ms-cloud__line">Cloud sessions started from Mini-Summa. A saved link does not mean the session is running.</p>
            <ul className="ms-cloud__sessions">
              {recent.map((r) => (
                <li key={r.id}>
                  <span className="ms-truncate">{r.title ?? r.sessionId}</span>
                  <span className="ms-cloud__when">{new Date(r.createdAt).toLocaleString()}</span>
                  <Button size="sm" icon="external" onClick={() => p.onOpenBrowser(r.url)}>Open</Button>
                  <Button size="sm" icon="copy" onClick={() => p.onCopyLink(r.url)}>Copy</Button>
                  <Button size="sm" variant="ghost" onClick={() => p.onOpenSession(r.url)}>Try here</Button>
                  <Button size="sm" variant="ghost" onClick={() => p.onFollowUp(r)}>Follow up</Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
