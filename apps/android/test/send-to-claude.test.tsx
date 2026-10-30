import { fireEvent, screen } from '@testing-library/react-native';
import { SendToClaudeScreen } from '../src/screens/SendToClaude';
import { SessionDetailScreen } from '../src/screens/SessionDetail';
import { RemoteControlScreen } from '../src/screens/RemoteControl';
import { Linking } from 'react-native';
import { router, setParams } from './mocks/expo-router';
import { makeAction, makeDevice, makeSession, SESSION_KEY } from './helpers/data';
import { createFakeCore, settle } from './helpers/fakeCore';
import type { FakeCore, Reply } from './helpers/fakeCore';
import { flush, mount } from './helpers/render';
import type { PendingAction } from '@minisumma/shared';

const PROMPT = 'Please run the full test suite and report any failures.';

async function openSend(seed: Parameters<typeof createFakeCore>[0] = {}, core = createFakeCore(seed)) {
  setParams({ key: SESSION_KEY });
  return mount(<SendToClaudeScreen />, { core });
}

async function compose(text = PROMPT) {
  await fireEvent.changeText(screen.getByLabelText('Text to send'), text);
  await fireEvent.press(screen.getByText('Review'));
}

const sendCalls = (core: FakeCore) => core.calls('POST /actions');
const created = (core: FakeCore, status: PendingAction['status'], failure: string | null = null): Reply => ({
  body: makeAction({ id: 'act_new_1', kind: 'claude_prompt', status, failure, text: PROMPT, summary: PROMPT, sessionKey: SESSION_KEY, generation: 2, createdBy: { kind: 'device', deviceId: core.data.device.id, name: core.data.device.name }, approvableBy: 'desktop_or_other_device' }),
});

describe('only managed, live sessions can reach the confirm step', () => {
  it.each([
    ['an external session', makeSession({ origin: 'external' }), 'This is an external session. Mini-Summa observes it but cannot type into it.'],
    ['a background session', makeSession({ origin: 'background' }), 'This is a background session. Mini-Summa observes it but cannot type into it.'],
    ['a resumable managed session', makeSession({ availability: 'resumable' }), 'This session is not running. Resume it in Mini-Summa on your PC first.'],
    ['a disconnected managed session', makeSession({ availability: 'disconnected' }), 'Mini-Summa lost the terminal connection to this session, so it cannot send text to it.'],
    ['an ended managed session', makeSession({ availability: 'ended' }), 'This session has ended.'],
  ])('%s shows why and has no way to compose or confirm', async (_name, session, reason) => {
    const { core } = await openSend({ snapshot: { ...(await import('./helpers/data')).makeSnapshot({ sessions: [session] }) } });
    expect(screen.getByText(reason)).toBeOnTheScreen();
    expect(screen.queryByLabelText('Text to send')).toBeNull();
    expect(screen.queryByText('Review')).toBeNull();
    expect(screen.queryByText('Send to Claude')).toBeNull();
    expect(sendCalls(core)).toHaveLength(0);
  });

  it('offers Remote Control for an external session', async () => {
    await openSend({ snapshot: (await import('./helpers/data')).makeSnapshot({ sessions: [makeSession({ origin: 'external' })] }) });
    await fireEvent.press(screen.getByText('Continue with Remote Control'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/session/remote-control', params: { key: SESSION_KEY } });
  });

  it('a phone without the prompt permission cannot compose', async () => {
    await openSend({ device: makeDevice({ scopes: ['read', 'notify'] }) });
    expect(screen.getByText(/not allowed to send prompts/)).toBeOnTheScreen();
    expect(screen.queryByText('Review')).toBeNull();
  });
});

describe('the session screen', () => {
  it('shows project and session exactly, and offers Send to Claude for a managed live session', async () => {
    setParams({ key: SESSION_KEY });
    await mount(<SessionDetailScreen />);
    expect(screen.getAllByText('GitManager').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/a1b2c3d4/).length).toBeGreaterThan(0);
    expect(screen.getByText('Managed by Mini-Summa')).toBeOnTheScreen();
    expect(screen.getByText('Live')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Send to Claude'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/session/send', params: { key: SESSION_KEY } });
  });

  it('for an external session explains it is observed only and offers Remote Control instead of Send', async () => {
    setParams({ key: SESSION_KEY });
    const { makeSnapshot } = await import('./helpers/data');
    await mount(<SessionDetailScreen />, { seed: { snapshot: makeSnapshot({ sessions: [makeSession({ origin: 'external' })] }) } });
    expect(screen.queryByText('Send to Claude')).toBeNull();
    expect(screen.getByText(/observes it but cannot type into it/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Continue with Remote Control'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/session/remote-control', params: { key: SESSION_KEY } });
  });

  it('words a suspected end as "may have ended" and an observed end as "ended"', async () => {
    setParams({ key: SESSION_KEY });
    const { makeSnapshot } = await import('./helpers/data');
    const suspected = makeSession({ availability: 'resumable', termination: { kind: 'suspected', reason: 'absent from the last listing', at: null } });
    const { unmount } = await mount(<SessionDetailScreen />, { seed: { snapshot: makeSnapshot({ sessions: [suspected] }) } });
    expect(screen.getByText(/May have ended\. Claude Code stopped listing it, which is not confirmation/)).toBeOnTheScreen();
    await unmount();
    const observed = makeSession({ availability: 'ended', termination: { kind: 'observed', reason: 'SessionEnd hook', at: '2026-10-30T10:00:00.000Z' } });
    await mount(<SessionDetailScreen />, { seed: { snapshot: makeSnapshot({ sessions: [observed] }) } });
    expect(screen.getByText('Ended: SessionEnd hook')).toBeOnTheScreen();
  });
});

describe('composing, confirming and sending', () => {
  it('shows the target explicitly, asks for confirmation with the exact text, then sends once with an idempotency key', async () => {
    const { core } = await openSend();
    // The target: project, session, kind, state, generation.
    expect(screen.getByText('GitManager')).toBeOnTheScreen();
    expect(screen.getByText('a1b2c3d4')).toBeOnTheScreen();
    expect(screen.getByText('Managed by Mini-Summa, live, Windows')).toBeOnTheScreen();
    expect(screen.getByText('Idle')).toBeOnTheScreen();
    expect(screen.getByText('2')).toBeOnTheScreen();

    await compose();
    expect(screen.getByText('Send this text to GitManager, session a1b2c3d4?')).toBeOnTheScreen();
    expect(screen.getByTestId('prompt-text').props.children).toBe(PROMPT);
    expect(sendCalls(core)).toHaveLength(0); // nothing is sent before the confirmation

    await fireEvent.press(screen.getByText('Send to Claude'));
    await flush();
    const [req] = sendCalls(core);
    expect(sendCalls(core)).toHaveLength(1);
    expect(req.body).toEqual({ sessionKey: SESSION_KEY, text: PROMPT, expectGeneration: 2 });
    expect(req.headers['idempotency-key']).toMatch(/^[0-9a-f-]{16,}$/);
    expect(req.headers.authorization).toBe('Bearer tok-secret');
    expect(await screen.findByText('Waiting for approval on your PC')).toBeOnTheScreen();
  });

  it('shows Sent when the desktop executed it at once (trusted phone)', async () => {
    const { core } = await openSend({ createStatus: 'executed' });
    await compose();
    await fireEvent.press(screen.getByText('Send to Claude'));
    await flush();
    expect(sendCalls(core)).toHaveLength(1);
    expect(await screen.findByText('Sent')).toBeOnTheScreen();
  });

  it('follows the action as the desktop decides it', async () => {
    const { core } = await openSend();
    await compose();
    await fireEvent.press(screen.getByText('Send to Claude'));
    await flush();
    expect(screen.getByText('Waiting for approval on your PC')).toBeOnTheScreen();
    const sent = core.data.actions[0];
    core.emit(11, { type: 'action.upserted', action: { ...sent, status: 'executed', executedAt: '2026-10-30T10:00:00.000Z' } });
    await flush();
    expect(screen.getByText('Sent')).toBeOnTheScreen();
  });

  it('shows a failed send as failed with the reason and never retries it on its own', async () => {
    jest.useFakeTimers();
    try {
      const core = createFakeCore();
      core.on('POST /actions', () => created(core, 'failed', 'The session is waiting for permission and cannot take typed text.'));
      await openSend({}, core);
      await compose();
      await fireEvent.press(screen.getByText('Send to Claude'));
      await settle();
      expect(screen.getByText('Could not send: The session is waiting for permission and cannot take typed text.')).toBeOnTheScreen();
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      await settle();
      expect(sendCalls(core)).toHaveLength(1);
    } finally { jest.useRealTimers(); }
  });

  it('keeps the same idempotency key when a flaky network loses the answer, so Retry cannot send twice', async () => {
    const core = createFakeCore();
    const server = new Map<string, Reply>();
    let first = true;
    core.on('POST /actions', (req) => {
      const key = req.headers['idempotency-key'];
      // The desktop receives and records the request, but the answer never arrives.
      if (!server.has(key)) server.set(key, created(core, 'pending'));
      if (first) { first = false; return 'network-error'; }
      return server.get(key)!;
    });
    await openSend({}, core);
    await compose();
    await fireEvent.press(screen.getByText('Send to Claude'));
    await flush();

    expect(await screen.findByText('Could not confirm it was sent')).toBeOnTheScreen();
    expect(screen.getByText(/may or may not have reached your PC/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Retry'));
    await flush();

    const calls = sendCalls(core);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers['idempotency-key']).toBe(calls[0].headers['idempotency-key']);
    expect(calls[1].body).toEqual(calls[0].body);
    expect(server.size).toBe(1); // the desktop knows one request, not two
    expect(await screen.findByText('Waiting for approval on your PC')).toBeOnTheScreen();
  });

  it('a different text after a lost answer is a new request with a new key', async () => {
    const core = createFakeCore();
    core.on('POST /actions', () => 'network-error');
    await openSend({}, core);
    await compose();
    await fireEvent.press(screen.getByText('Send to Claude'));
    await flush();
    await fireEvent.press(await screen.findByText('Edit text'));
    await compose('A different instruction.');
    await fireEvent.press(screen.getByText('Send to Claude'));
    await flush();
    const calls = sendCalls(core);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers['idempotency-key']).not.toBe(calls[0].headers['idempotency-key']);
  });

  it('a refusal from the desktop ends the attempt: nothing was sent, no retry, a new send is a new request', async () => {
    const core = createFakeCore();
    core.on('POST /actions', () => ({ status: 409, body: { error: { code: 'target_not_live', message: 'The session is no longer live.' } } }));
    await openSend({}, core);
    await compose();
    await fireEvent.press(screen.getByText('Send to Claude'));
    await flush();
    expect(await screen.findByText('Could not send: The session is no longer live.')).toBeOnTheScreen();
    expect(screen.getByText('Nothing was sent.')).toBeOnTheScreen();
    expect(screen.queryByText('Retry')).toBeNull();
    expect(sendCalls(core)).toHaveLength(1);
  });

  it('ignores a second tap while the first send is in flight', async () => {
    const core = createFakeCore();
    let release: (r: Reply) => void = () => undefined;
    core.on('POST /actions', () => new Promise<Reply>((resolve) => { release = resolve; }));
    await openSend({}, core);
    await compose();
    await fireEvent.press(screen.getByText('Send to Claude'));
    await fireEvent.press(screen.getByText('Send to Claude'));
    await flush(2);
    expect(sendCalls(core)).toHaveLength(1);
    release(created(core, 'pending'));
    await flush();
    expect(await screen.findByText('Waiting for approval on your PC')).toBeOnTheScreen();
  });

  it('warns and withholds Send if the session was restarted while reviewing', async () => {
    const { core } = await openSend();
    await compose();
    core.emit(11, { type: 'session.upserted', session: makeSession({ generation: 3 }) });
    await flush();
    expect(screen.getByText(/restarted while you were reviewing/)).toBeOnTheScreen();
    expect(screen.queryByText('Send to Claude')).toBeNull();
    expect(screen.getByText('Review again')).toBeOnTheScreen();
    expect(sendCalls(core)).toHaveLength(0);
  });

  it('does not allow empty text', async () => {
    await openSend();
    await fireEvent.changeText(screen.getByLabelText('Text to send'), '   ');
    expect(screen.getByLabelText('Review').props.accessibilityState.disabled).toBe(true);
  });
});

describe('Remote Control for external sessions', () => {
  it('explains what to type and opens claude.ai/code', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    setParams({ key: SESSION_KEY });
    const { makeSnapshot } = await import('./helpers/data');
    await mount(<RemoteControlScreen />, { seed: { snapshot: makeSnapshot({ sessions: [makeSession({ origin: 'external' })] }) } });
    expect(screen.getByText('Mini-Summa observes external sessions but cannot type into them.')).toBeOnTheScreen();
    expect(screen.getByText(/type \/remote-control/)).toBeOnTheScreen();
    expect(screen.getByText(/claude --remote-control/)).toBeOnTheScreen();
    expect(screen.getByText(/continue the session from the Claude app/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Open claude.ai/code'));
    expect(open).toHaveBeenCalledWith('https://claude.ai/code');
  });
});
