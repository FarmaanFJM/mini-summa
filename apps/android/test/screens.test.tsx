import { Linking } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { ActivityScreen } from '../src/screens/Activity';
import { HomeScreen } from '../src/screens/Home';
import { ProjectDetailScreen } from '../src/screens/ProjectDetail';
import { SettingsScreen } from '../src/screens/Settings';
import { SessionProvider, useSession } from '../src/session/SessionProvider';
import { ConnectionManager } from '../src/connection/ConnectionManager';
import { NEEDS_FIREBASE_MESSAGE } from '../src/notifications/push';
import { pushStatusStore } from '../src/notifications/pushStatus';
import { ToastProvider } from '../src/ui/overlays';
import { router, setParams } from './mocks/expo-router';
import { makeActivity, makeConversation, makeDevice, makeProject, makeSession, makeSnapshot, makeSummary, OTHER_KEY, SESSION_KEY } from './helpers/data';
import { createFakeCore } from './helpers/fakeCore';
import { creds, flush, mount } from './helpers/render';

describe('home', () => {
  it('lists what needs you first, then projects with live counts and an attention marker', async () => {
    const seed = {
      snapshot: makeSnapshot({
        projects: [makeProject({ id: 'prj_1', name: 'GitManager' }), makeProject({ id: 'prj_2', name: 'Atlas', sortOrder: 1 })],
        sessions: [
          makeSession({ attention: { kind: 'permission', since: null }, state: 'needs_permission' }),
          makeSession({ key: OTHER_KEY, projectId: 'prj_2', projectName: 'Atlas', sessionId: 'f9e8d7c6-0000-4000-8000-000000000002' }),
        ],
      }),
      reports: [makeSummary({ id: 'rep_1', taskTitle: 'Add retry to the sync job', read: false })],
    };
    await mount(<HomeScreen />, { seed });
    expect(screen.getByText('Needs you')).toBeOnTheScreen();
    expect(screen.getByText(/Permission request: GitManager, session a1b2c3d4/)).toBeOnTheScreen();
    expect(screen.getByText('Bash: git push origin main')).toBeOnTheScreen();
    expect(screen.getByText('Add retry to the sync job')).toBeOnTheScreen();
    expect(screen.getByText('Projects')).toBeOnTheScreen();
    expect(screen.getAllByText('1 live session').length).toBe(2);
    expect(screen.getByText('1 unread report')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Needs you').length).toBeGreaterThan(0);

    await fireEvent.press(screen.getByText('Atlas'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/project', params: { id: 'prj_2' } });
  });

  it('says nothing needs you when that is true', async () => {
    await mount(<HomeScreen />, { seed: { actions: [], reports: [], snapshot: makeSnapshot({ sessions: [makeSession()] }) } });
    expect(screen.getByText('Nothing needs you right now.')).toBeOnTheScreen();
  });
});

describe('project detail', () => {
  it('shows sessions with origin, availability and state, and opens a ChatGPT conversation with Linking', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    setParams({ id: 'prj_1' });
    const seed = {
      snapshot: makeSnapshot({
        sessions: [
          makeSession({ stateLabel: 'Waiting for your permission', state: 'needs_permission', attention: { kind: 'permission', since: null } }),
          makeSession({ key: OTHER_KEY, origin: 'external', availability: 'resumable', stateLabel: 'Idle', termination: { kind: 'suspected', reason: 'absent from the listing', at: null } }),
        ],
        conversations: [makeConversation(), makeConversation({ id: 'cnv_2', title: 'Release notes', url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', position: 1 })],
      }),
    };
    await mount(<ProjectDetailScreen />, { seed });
    expect(screen.getByText('Managed · Live · Waiting for your permission')).toBeOnTheScreen();
    expect(screen.getByText('External · Resumable · Idle')).toBeOnTheScreen();
    expect(screen.getByText(/^May have ended\./)).toBeOnTheScreen();
    expect(screen.getByText('Preferred for this project')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Release notes'));
    expect(open).toHaveBeenCalledWith('https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('opens a session from the list', async () => {
    setParams({ id: 'prj_1' });
    await mount(<ProjectDetailScreen />);
    await fireEvent.press(screen.getByText('Session a1b2c3d4'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/session', params: { key: SESSION_KEY } });
  });
});

describe('activity feed', () => {
  const seed = {
    snapshot: makeSnapshot({ projects: [makeProject(), makeProject({ id: 'prj_2', name: 'Atlas', sortOrder: 1 })] }),
    activity: [
      makeActivity({ id: 'a1', title: 'Needs permission: GitManager / a1b2c3d4' }),
      makeActivity({ id: 'a2', title: 'Turn ended: Atlas', projectId: 'prj_2', projectName: 'Atlas', requiresAction: false, read: true, links: [{ kind: 'project', id: 'prj_2' }] }),
    ],
  };

  it('filters by needs action, unread and project from a sheet', async () => {
    await mount(<ActivityScreen />, { seed });
    expect(screen.getByText('Turn ended: Atlas')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('activity-filter'));
    await fireEvent.press(screen.getByText('Needs action'));
    await fireEvent.press(screen.getByText('Atlas'));
    await fireEvent.press(screen.getByLabelText('Close'));
    expect(screen.getByText('Nothing matches these filters.')).toBeOnTheScreen();
    expect(screen.getByTestId('activity-filter-text').props.children).toBe('Showing: Needs action, Atlas');

    await fireEvent.press(screen.getByText('Clear filters'));
    expect(screen.getByText('Turn ended: Atlas')).toBeOnTheScreen();
    expect(screen.getByText('Needs permission: GitManager / a1b2c3d4')).toBeOnTheScreen();
  });

  it('marks an entry read and opens what it links to when tapped', async () => {
    const { core } = await mount(<ActivityScreen />, { seed });
    await fireEvent.press(screen.getByText('Needs permission: GitManager / a1b2c3d4'));
    await flush();
    expect(core.calls('POST /activity/read')[0].body).toEqual({ ids: ['a1'] });
    expect(router.push).toHaveBeenCalledWith({ pathname: '/session', params: { key: SESSION_KEY } });
  });

  it('marks everything read from the sheet', async () => {
    const { core } = await mount(<ActivityScreen />, { seed });
    await fireEvent.press(screen.getByTestId('activity-filter'));
    await fireEvent.press(screen.getByText(/Mark all as read/));
    await flush();
    expect(core.calls('POST /activity/read')[0].body).toEqual({ all: true });
  });
});

// Like the app's root layout: paired screens are only mounted once the stored pairing is known.
function Gate({ children }: { children: React.ReactNode }) {
  return useSession().phase === 'paired' ? <>{children}</> : null;
}

describe('settings', () => {
  const memoryStore = () => ({ load: jest.fn(async () => creds), save: jest.fn(async () => undefined), clear: jest.fn(async () => undefined) });

  async function mountSettings(seed: Parameters<typeof createFakeCore>[0] = {}) {
    const core = createFakeCore(seed);
    const store = memoryStore();
    await render(
      <SessionProvider store={store} createManager={(c, onRevoked) => new ConnectionManager({ credentials: c, fetch: core.fetch, WebSocket: core.WebSocket, onRevoked })}>
        <ToastProvider><Gate><SettingsScreen /></Gate></ToastProvider>
      </SessionProvider>,
    );
    await flush();
    await act(async () => { core.connect(); });
    await flush();
    return { core, store };
  }

  it('shows this device, its permissions, the connection and the app version', async () => {
    await mountSettings({ device: makeDevice({ name: 'Pixel 8', trusted: false }) });
    expect(screen.getByText('Pixel 8')).toBeOnTheScreen();
    expect(screen.getByText(/View status, reports and activity/)).toBeOnTheScreen();
    expect(screen.getByText(/Approve or reject requests/)).toBeOnTheScreen();
    expect(screen.getByText(/Prompts sent from this phone wait for your approval on your PC/)).toBeOnTheScreen();
    expect(within(screen.getByTestId('settings-address')).getByText('https://pc.tail1234.ts.net')).toBeOnTheScreen();
    expect(screen.getByText('Live')).toBeOnTheScreen();
    expect(screen.getByText('0.1.0')).toBeOnTheScreen();
  });

  it('says when this phone is trusted', async () => {
    await mountSettings({ device: makeDevice({ trusted: true }) });
    expect(screen.getByText(/Prompts sent from this phone run without a second approval/)).toBeOnTheScreen();
  });

  it('explains that push needs the user own Firebase project, and local notifications still work', async () => {
    await mountSettings();
    await act(async () => { pushStatusStore.set({ state: 'needs_firebase', message: NEEDS_FIREBASE_MESSAGE }); });
    expect(within(screen.getByTestId('push-status')).getByText(/Push notifications need your own Firebase project\. See docs\/ANDROID\.md/)).toBeOnTheScreen();
    expect(within(screen.getByTestId('push-status')).getByText(/Live updates inside the app keep working/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Send a test notification'));
    await flush();
    expect(screen.getByText('Test notification sent to this phone')).toBeOnTheScreen();
  });

  it('unpairs only after confirmation, and wipes secure storage', async () => {
    const { store } = await mountSettings();
    await fireEvent.press(screen.getByText('Unpair this phone'));
    expect(screen.getByText('Unpair this phone?')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(store.clear).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Unpair this phone'));
    await fireEvent.press(screen.getByText('Unpair phone'));
    await flush();
    expect(store.clear).toHaveBeenCalledTimes(1);
  });
});
