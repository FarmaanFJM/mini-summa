import { fireEvent, screen } from '@testing-library/react-native';
import { InboxScreen } from '../src/screens/Inbox';
import { router } from './mocks/expo-router';
import { makeAction, makeDevice, SESSION_KEY } from './helpers/data';
import { createFakeCore } from './helpers/fakeCore';
import { flush, mount } from './helpers/render';

const longPrompt = ['Refactor the sync worker:', ...Array.from({ length: 30 }, (_, i) => `  step ${i + 1}: keep the public API stable`), 'END OF PROMPT'].join('\n');

describe('inbox with the approve permission', () => {
  it('shows the exact tool and redacted excerpt of a permission request and approves it', async () => {
    const { core, manager } = await mount(<InboxScreen />);
    expect(screen.getByText('Permission request')).toBeOnTheScreen();
    expect(screen.getByText('GitManager, session a1b2c3d4')).toBeOnTheScreen();
    const summary = screen.getByTestId('action-summary');
    expect(summary.props.children).toBe('Bash: git push origin main');
    expect(summary.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ fontFamily: 'monospace' })]));

    await fireEvent.press(screen.getByText('Approve'));
    await flush();
    expect(core.calls('POST /actions/:id/approve')).toHaveLength(1);
    expect(core.calls('POST /actions/:id/approve')[0].path).toBe('/actions/act_1/approve');
    expect(manager.getSnapshot().state.actions[0].status).toBe('executed');
  });

  it('rejects a request', async () => {
    const { core } = await mount(<InboxScreen />);
    await fireEvent.press(screen.getByText('Reject'));
    await flush();
    expect(core.calls('POST /actions/:id/reject')).toHaveLength(1);
  });

  it('shows the full text of a prompt waiting for approval, not a shortened version', async () => {
    const action = makeAction({
      id: 'act_p', kind: 'claude_prompt', text: longPrompt, summary: 'Refactor the sync worker:', createdBy: { kind: 'device', deviceId: 'dev_other', name: 'Old tablet' },
      approvableBy: 'desktop_or_other_device',
    });
    await mount(<InboxScreen />, { seed: { actions: [action] } });
    expect(screen.getByText('Prompt for Claude')).toBeOnTheScreen();
    expect(screen.getByTestId('action-summary').props.children).toBe(longPrompt);
    expect(screen.getByText(/Sent from Old tablet/)).toBeOnTheScreen();
    expect(screen.getByText('Approve')).toBeOnTheScreen();
  });

  it('does not offer to approve a prompt that this very phone sent, and says where to approve it', async () => {
    const own = makeAction({
      id: 'act_own', kind: 'claude_prompt', text: 'Run the tests', summary: 'Run the tests', createdBy: { kind: 'device', deviceId: 'dev_1', name: 'Pixel 8' },
      approvableBy: 'desktop_or_other_device',
    });
    await mount(<InboxScreen />, { seed: { actions: [own] } });
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Reject')).toBeNull();
    expect(screen.getByTestId('decision-blocked').props.children).toBe('You sent this from this phone. Approve it on your PC or on another paired phone.');
  });

  it('keeps a permission error as a permission error, not as a removal of the phone', async () => {
    const core = createFakeCore();
    core.on('POST /actions/:id/approve', () => ({ status: 403, body: { error: { code: 'forbidden', message: 'This action is not allowed for this client.' } } }));
    const { manager } = await mount(<InboxScreen />, { core });
    await fireEvent.press(screen.getByText('Approve'));
    await flush();
    expect(screen.getByText(/not allowed to do that/)).toBeOnTheScreen();
    expect(manager.getSnapshot().status).toBe('connected');
  });

  it('shows an empty state when nothing waits, and recent outcomes below', async () => {
    const done = makeAction({ id: 'act_old', kind: 'claude_prompt', status: 'executed', decidedAt: '2026-10-30T08:30:00.000Z', summary: 'Run the tests' });
    await mount(<InboxScreen />, { seed: { actions: [done] } });
    expect(screen.getByText('No requests are waiting for you.')).toBeOnTheScreen();
    expect(screen.getByText('Recent')).toBeOnTheScreen();
    expect(screen.getByText('Sent')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Sent'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/session', params: { key: SESSION_KEY } });
  });
});

describe('inbox without the approve permission', () => {
  const readOnly = { device: makeDevice({ scopes: ['read', 'notify'] }) };

  it('shows the request but hides Approve and Reject and explains why', async () => {
    const { core } = await mount(<InboxScreen />, { seed: readOnly });
    expect(screen.getByTestId('action-summary').props.children).toBe('Bash: git push origin main');
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Reject')).toBeNull();
    expect(screen.getByTestId('decision-blocked').props.children).toContain('cannot approve or reject');
    expect(core.calls('POST /actions/:id/approve')).toHaveLength(0);
  });

  it('the owner (desktop scope) may decide', async () => {
    await mount(<InboxScreen />, { seed: { device: makeDevice({ scopes: ['desktop'] }) } });
    expect(screen.getByText('Approve')).toBeOnTheScreen();
  });
});
