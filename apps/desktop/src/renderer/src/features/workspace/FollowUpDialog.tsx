import { MAX_PROMPT_CHARS } from '@minisumma/shared';
import type { CloudFollowUpResult, CloudSessionRecord } from '@minisumma/shared';
import { useState } from 'react';
import { useApi } from '../../app/runtime';
import { Button, Dialog, Field, Tag, TextArea } from '../../ui';

const OUTCOME: Record<CloudFollowUpResult['outcome'], string> = { accepted: 'Accepted by the CLI', rejected: 'Rejected', unknown: 'Result unknown' };

/**
 * A follow-up message to an existing cloud session, through the documented `claude -p "<message>" --cloud <id>` form. The answer is one of
 * accepted, rejected or unknown, and "accepted" is about the CLI taking the message, never about Claude having done anything with it.
 */
export function FollowUpDialog({ record, onClose }: { record: CloudSessionRecord | null; onClose: () => void }) {
  const api = useApi();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloudFollowUpResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => { setText(''); setResult(null); setError(null); onClose(); };
  const send = async () => {
    if (!record) return;
    setBusy(true); setError(null); setResult(null);
    try { setResult(await api.call('cloud.followUp', { params: { id: record.id }, body: { message: text } })); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={record !== null} onClose={close} title="Follow-up message" description={record ? (record.title ?? record.sessionId) : undefined} size="md" busy={busy}
      footer={(
        <>
          <Button onClick={close} disabled={busy}>Close</Button>
          <Button variant="primary" loading={busy} disabled={text.trim() === '' || text.length > MAX_PROMPT_CHARS} onClick={() => { void send(); }}>Send message</Button>
        </>
      )}
    >
      <Field label="Message" hint="Sent to the cloud session through the Claude CLI, whole and unchanged. A message the command line cannot carry is not sent; use claude.ai for it.">
        <TextArea rows={7} className="ms-composer" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
      </Field>
      {result ? (
        <div className="ms-notice" data-tone={result.outcome === 'accepted' ? undefined : result.outcome === 'rejected' ? 'error' : 'attention'} role="status">
          <span className="ms-notice__text"><Tag>{OUTCOME[result.outcome]}</Tag> {result.note}</span>
        </div>
      ) : null}
      {error ? <div className="ms-notice" data-tone="error" role="alert"><span className="ms-notice__text">{error}</span></div> : null}
    </Dialog>
  );
}
