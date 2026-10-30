import type { PushTestResult } from '@minisumma/shared';
import { useRef, useState } from 'react';
import { useApi, useApp } from '../../app/runtime';
import { Button, ConfirmDialog, Field, TextArea, toast } from '../../ui';
import { errorText } from '../reports/support';
import { Group } from './controls';

/** What Firebase did with a test push, in words. It says accepted, not arrived: only the phone knows that. */
export function testPushWords(r: PushTestResult): { tone: 'ok' | 'warning'; text: string } {
  if (r.skipped) return { tone: 'warning', text: r.skipped };
  if (r.sent === 0 && r.failed === 0) return { tone: 'warning', text: 'There was no phone to send it to.' };
  const accepted = `Firebase accepted ${r.sent} ${r.sent === 1 ? 'message' : 'messages'}`;
  if (r.failed > 0) return { tone: 'warning', text: `${accepted}, and ${r.failed} could not be sent. Open the Mini-Summa app on that phone so it registers again, then test again.` };
  return { tone: 'ok', text: `${accepted}. It should reach the phone within a few seconds. If it does not, check that the app is allowed to show notifications.` };
}

export function PushSection() {
  const api = useApi();
  const configured = useApp((s) => s.settings?.mobile.push.configured ?? false);
  const devices = useApp((s) => s.devices);
  const [json, setJson] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [busy, setBusy] = useState<'import' | 'test' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ReturnType<typeof testPushWords> | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const registered = devices.filter((d) => d.revokedAt === null && d.pushRegistered);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
        reader.readAsText(file);
      });
      setJson(text);
      setFileName(file.name);
      setError(null);
    } catch (err) {
      setError(`That file could not be read: ${errorText(err)}`);
    }
  };

  const importKey = async () => {
    setBusy('import');
    setError(null);
    setTestResult(null);
    try {
      const result = await api.call('push.configure', { body: { serviceAccountJson: json } });
      setProject(result.firebaseProject);
      // The key is a secret: once it is stored it leaves the screen, and it is never shown again.
      setJson('');
      setFileName(null);
      toast({ title: 'Push is set up', body: `Using the Firebase project ${result.firebaseProject}.`, kind: 'success' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy('test');
    setError(null);
    setTestResult(null);
    try {
      setTestResult(testPushWords(await api.call('push.test')));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async () => {
    setBusy('clear');
    setError(null);
    try {
      await api.call('push.clear');
      setProject(null);
      setTestResult(null);
      setConfirmClear(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ms-set-page">
      <Group title="Status">
        <dl className="ms-x-kv" aria-label="Push status">
          <dt>Push</dt>
          <dd>{configured ? `Set up${project ? ` with the Firebase project ${project}` : ' with your own Firebase project'}` : 'Not set up'}</dd>
          <dt>Phones</dt>
          <dd>{registered.length === 0 ? 'No phone has registered for push yet.' : `${registered.map((d) => d.name).join(', ')} ${registered.length === 1 ? 'is' : 'are'} registered.`}</dd>
        </dl>
        {configured ? (
          <div className="ms-x-actions">
            <Button loading={busy === 'test'} onClick={() => { void sendTest(); }}>Send a test push</Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmClear(true)}>Remove the key</Button>
          </div>
        ) : null}
        {testResult ? <p className="ms-x-result" data-tone={testResult.tone === 'ok' ? undefined : 'warning'} role="status">{testResult.text}</p> : null}
      </Group>

      <Group title={configured ? 'Replace the key' : 'Set up push'} note="Push is optional. It tells a paired phone that something needs you while the Mini-Summa app is closed. It uses your own Firebase project, so no one else is involved.">
        <ol className="ms-set-steps">
          <li>In the Firebase console open Project settings, then Service accounts.</li>
          <li>Choose Generate new private key and download the file.</li>
          <li>Pick that file here, or paste its whole contents unchanged.</li>
        </ol>
        <Field label="Service account key" hint={fileName ? `Loaded from ${fileName}.` : 'The whole JSON file from Firebase.'}>
          <TextArea
            rows={5} className="ms-mono" spellCheck={false} autoComplete="off" value={json}
            onChange={(e) => { setJson(e.target.value); setFileName(null); }}
          />
        </Field>
        <div className="ms-x-actions">
          <input ref={picker} type="file" accept=".json,application/json" className="ms-x-hidden" aria-label="Choose the key file" tabIndex={-1} onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ''; }} />
          <Button icon="upload" onClick={() => picker.current?.click()}>Choose a file</Button>
          <Button variant="primary" loading={busy === 'import'} disabled={json.trim() === ''} onClick={() => { void importKey(); }}>{configured ? 'Replace the key' : 'Import the key'}</Button>
        </div>
        {error && !confirmClear ? <p className="ms-x-error" role="alert">{error}</p> : null}
      </Group>

      <Group title="What a push contains">
        <ul className="ms-set-points">
          <li>The project name and one fixed sentence, such as "A report is ready" or "Claude is waiting for permission".</li>
          <li>Ids that let the app open the right place. Nothing else.</li>
          <li>Report text, prompts, task titles, file paths and command text never go into a push.</li>
          <li>The key stays on this PC, in a file only your account can read. It is not logged and it is not shown again.</li>
          <li>This PC sends the push. If the PC is asleep or off, no push is sent, and the phone shows nothing new until the PC is back.</li>
        </ul>
        <p className="ms-x-note">A phone registers itself when you open the Mini-Summa app on it and allow notifications. Quiet mode and each project's Phone switch decide whether a push is sent at all.</p>
      </Group>

      <ConfirmDialog
        open={confirmClear}
        destructive
        title="Remove the Firebase key?"
        description="Push stops and the key file is deleted from this PC. Your Firebase project is not changed. Phones keep working through their live connection, but they will not hear from Mini-Summa while the app is closed."
        confirmLabel="Remove the key"
        busy={busy === 'clear'}
        error={confirmClear ? error : null}
        onConfirm={clearKey}
        onCancel={() => { setConfirmClear(false); setError(null); }}
      />
    </div>
  );
}
