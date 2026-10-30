import { act, screen } from '@testing-library/react-native';
import { describeConnection } from '../src/connection/banner';
import { HomeScreen } from '../src/screens/Home';
import { ReportsScreen } from '../src/screens/Reports';
import { emit, flush, mount } from './helpers/render';
import { settle } from './helpers/fakeCore';

const NOW = new Date(2026, 9, 30, 14, 40, 0);
const heard = new Date(2026, 9, 30, 14, 32, 7).getTime();

type Input = Parameters<typeof describeConnection>[0];
const base = (over: Partial<Input> & { loaded?: boolean } = {}): Input => ({
  status: 'connected', cause: null, lastError: null, lastHeardAt: heard,
  endpoint: { baseUrl: 'https://pc.tail1234.ts.net', serverName: "Farmaan's PC" },
  state: { loaded: over.loaded ?? true },
  ...over,
});

describe('banner wording', () => {
  it('shows nothing while the data is live', () => {
    expect(describeConnection(base({ status: 'connected' }), NOW).visible).toBe(false);
  });

  it('says it is reconnecting, that the data is not live and when it was last updated', () => {
    const b = describeConnection(base({ status: 'reconnecting' }), NOW);
    expect(b).toMatchObject({ visible: true, tone: 'warning', title: 'Reconnecting to your PC', lastUpdated: 'Last updated 14:32' });
    expect(b.detail).toContain('not live');
  });

  it('says honestly that a sleeping or powered off PC is the likely cause when the address does not answer', () => {
    const b = describeConnection(base({ status: 'desktop_unreachable', cause: 'no_answer' }), NOW);
    expect(b.title).toBe('Cannot reach your PC');
    expect(b.detail).toContain('most likely asleep or turned off');
    expect(b.detail).toContain('Tailscale');
    expect(b.detail).toContain('not live');
    expect(b.lastUpdated).toBe('Last updated 14:32');
  });

  it('puts the day on the time when the last update was not today', () => {
    const b = describeConnection(base({ status: 'desktop_unreachable', cause: 'no_answer', lastHeardAt: new Date(2026, 9, 29, 21, 5).getTime() }), NOW);
    expect(b.lastUpdated).toBe('Last updated Yesterday 21:05');
  });

  it('separates "the PC is on but Mini-Summa is not answering" from "the PC does not answer"', () => {
    const b = describeConnection(base({ status: 'desktop_unreachable', cause: 'server_error', lastError: 'upstream closed' }), NOW);
    expect(b.title).toBe('Mini-Summa on your PC is not responding');
    expect(b.detail).toContain('Your PC answered');
    expect(b.detail).toContain('upstream closed');
    expect(b.detail).not.toContain('asleep');
  });

  it('says when plain requests work but live updates cannot open', () => {
    const b = describeConnection(base({ status: 'desktop_unreachable', cause: 'stream_blocked' }), NOW);
    expect(b.title).toBe('Live updates cannot connect');
  });

  it('uses the exact removal message when the desktop removed the phone', () => {
    const b = describeConnection(base({ status: 'revoked' }), NOW);
    expect(b).toMatchObject({ visible: true, tone: 'danger', title: 'This phone was removed in Mini-Summa. Pair again.' });
  });

  it('while connecting for the first time there is nothing stale to warn about', () => {
    const b = describeConnection(base({ status: 'connecting', loaded: false, lastHeardAt: null }), NOW);
    expect(b).toMatchObject({ visible: true, title: "Connecting to Farmaan's PC", lastUpdated: null });
  });

  it('when paused in the background with data, says the data is not live', () => {
    expect(describeConnection(base({ status: 'idle' }), NOW)).toMatchObject({ visible: true, title: 'Not connected', lastUpdated: 'Last updated 14:32' });
    expect(describeConnection(base({ status: 'idle', loaded: false, lastHeardAt: null }), NOW).visible).toBe(false);
  });

  it('never uses an em dash', () => {
    for (const status of ['reconnecting', 'desktop_unreachable', 'revoked', 'connecting', 'idle'] as const) {
      for (const cause of [null, 'no_answer', 'server_error', 'stream_blocked'] as const) {
        const b = describeConnection(base({ status, cause }), NOW);
        expect(`${b.title} ${b.detail ?? ''} ${b.lastUpdated ?? ''}`).not.toContain('\u2014');
      }
    }
  });
});

describe('the banner on screen', () => {
  it('appears on every tab screen as soon as the stream drops, and disappears when live again', async () => {
    const { core } = await mount(<HomeScreen />);
    expect(screen.queryByTestId('connection-banner')).toBeNull();

    await act(async () => { core.lastSocket().serverClose(1006); });
    await flush(2);
    expect(screen.getByTestId('connection-banner')).toBeOnTheScreen();
    expect(screen.getByText('Reconnecting to your PC')).toBeOnTheScreen();
    expect(screen.getByTestId('banner-last-updated').props.children).toMatch(/^Last updated \d\d:\d\d$/);
  });

  it('says the PC is probably asleep after the connection has stayed down', async () => {
    const { core } = await mount(<ReportsScreen />);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    core.setOffline(true);
    await act(async () => { core.lastSocket().serverClose(1006); });
    await act(async () => { await jest.advanceTimersByTimeAsync(15_000); });
    await settle();
    expect(screen.getByText('Cannot reach your PC')).toBeOnTheScreen();
    expect(screen.getByText(/most likely asleep or turned off/)).toBeOnTheScreen();
    // The reports from before are still listed, but the banner above them says they are not live.
    expect(screen.getByText('Add retry to the sync job')).toBeOnTheScreen();
  });

  it('is not shown on top of a screen that has data from a live connection', async () => {
    const { core } = await mount(<HomeScreen />);
    await emit(core, 11, { type: 'counts', counts: { unreadActivity: 0, actionsNeeded: 0, pendingActions: 0, reportsAwaitingHandoff: 0, liveSessions: 1 } });
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });
});

