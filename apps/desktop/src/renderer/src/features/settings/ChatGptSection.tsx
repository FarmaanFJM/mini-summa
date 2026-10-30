import type { ChatGptViewState } from '@minisumma/shared';
import { useEffect, useState } from 'react';
import { useNative } from '../../app/native';
import { Button, Icon, Radio } from '../../ui';
import { Group, PageStatus } from './controls';
import { viewStatusWords } from './model';
import { useSettings } from './useSettings';

/** The state of the embedded ChatGPT view, kept current. Null while the host has not answered, or when there is no view. */
export function useChatGptView(enabled: boolean): ChatGptViewState | null {
  const native = useNative();
  const [state, setState] = useState<ChatGptViewState | null>(null);
  useEffect(() => {
    if (!enabled) { setState(null); return undefined; }
    let cancelled = false;
    native.chatgpt.getState().then((s) => { if (!cancelled) setState(s); }, () => {});
    const off = native.chatgpt.onState((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; off(); };
  }, [enabled, native]);
  return state;
}

function Choice({ name, checked, onChange, label, hint }: { name: string; checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <div className="ms-set-choice">
      <Radio name={name} checked={checked} onChange={onChange} label={<span className="ms-set-choice__text"><span className="ms-x-row__label">{label}</span><span className="ms-x-row__hint">{hint}</span></span>} />
    </div>
  );
}

export function ChatGptSection() {
  const native = useNative();
  const { settings, save, status } = useSettings();
  const mode = settings?.chatgpt.mode ?? 'embedded';
  const view = useChatGptView(mode === 'embedded' && native.hasEmbeddedChatGpt);
  if (!settings) return <p className="ms-x-note">Settings are not loaded yet.</p>;

  return (
    <div className="ms-set-page">
      <PageStatus status={status} />

      <Group title="How ChatGPT opens" note="Google sign-in is often refused inside embedded browsers. If ChatGPT will not let you sign in here, use your browser instead: copying a report and opening the conversation work the same in both.">
        <div role="radiogroup" aria-label="How ChatGPT opens" className="ms-x-stack ms-x-stack--tight">
          <Choice
            name="chatgpt-mode" checked={mode === 'embedded'} onChange={() => { void save({ chatgpt: { mode: 'embedded' } }); }}
            label="Inside Mini-Summa" hint="ChatGPT opens in a view next to Claude, with its own sign-in. Mini-Summa never reads or changes the page."
          />
          <Choice
            name="chatgpt-mode" checked={mode === 'external'} onChange={() => { void save({ chatgpt: { mode: 'external' } }); }}
            label="In your browser" hint="Mini-Summa opens the conversation in your browser. Nothing is shown inside Mini-Summa."
          />
        </div>
      </Group>

      {mode === 'external' ? (
        <Group title="Which browser tab" note="The extension can bring a ChatGPT tab you already have open to the front instead of opening another one. It is optional.">
          <div role="radiogroup" aria-label="Which browser tab" className="ms-x-stack ms-x-stack--tight">
            <Choice
              name="chatgpt-browser" checked={settings.chatgpt.externalBrowser === 'default'} onChange={() => { void save({ chatgpt: { externalBrowser: 'default' } }); }}
              label="Open a new tab in the default browser" hint="Works everywhere. Opening the same conversation twice gives two tabs."
            />
            <Choice
              name="chatgpt-browser" checked={settings.chatgpt.externalBrowser === 'extension'} onChange={() => { void save({ chatgpt: { externalBrowser: 'extension' } }); }}
              label="Use the Mini-Summa browser extension" hint="Focuses the tab that already shows the conversation. Set it up under Browser extension."
            />
          </div>
        </Group>
      ) : (
        <Group title="The embedded view">
          {!native.hasEmbeddedChatGpt ? (
            <p className="ms-x-note">The embedded view exists only in the desktop app. This window cannot show it, so ChatGPT opens in your browser.</p>
          ) : (
            <>
              <dl className="ms-x-kv" aria-label="Embedded view status">
                <dt>Status</dt>
                <dd>{view ? viewStatusWords(view.status) : 'Waiting for the view'}</dd>
                {view?.title ? (<><dt>Page</dt><dd>{view.title}</dd></>) : null}
                {view?.url ? (<><dt>Address</dt><dd className="ms-mono ms-break">{view.url}</dd></>) : null}
              </dl>
              {view && view.note ? <div className="ms-notice" data-tone={view.status === 'blocked' || view.status === 'error' ? 'error' : 'attention'}><Icon name="info" /><span className="ms-notice__text">{view.note}</span></div> : null}
              {view && (view.status === 'blocked' || view.status === 'login_required') ? (
                <div className="ms-x-actions">
                  <Button onClick={() => { void save({ chatgpt: { mode: 'external' } }); }}>Use my browser instead</Button>
                </div>
              ) : null}
            </>
          )}
        </Group>
      )}
    </div>
  );
}
