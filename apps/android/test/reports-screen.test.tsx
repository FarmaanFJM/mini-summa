import { Linking, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import { fireEvent, screen } from '@testing-library/react-native';
import { ReportDetailScreen } from '../src/screens/ReportDetail';
import { ReportsScreen } from '../src/screens/Reports';
import { setParams, router } from './mocks/expo-router';
import { makeConversation, makeDelivery, makeProject, makeReport, makeSnapshot, makeSummary } from './helpers/data';
import { flush, mount } from './helpers/render';
import { createFakeCore } from './helpers/fakeCore';

const SECTION_ONE = 'First we replaced the polling loop with an event driven worker so the job no longer wakes every second.';
const SECTION_TWO = 'Then we added exponential backoff, capped at five minutes, with jitter so retries do not line up.';
const SECTION_THREE = 'Finally the failure path now records the last error on the job row, which the UI shows verbatim.';
const CODE_LINE = 'npm run test -- --runInBand --testPathPattern=sync';
const LAST_LINE = 'LAST LINE OF THE REPORT, if you can read this the whole text was rendered.';

const body = [
  '## Summary',
  SECTION_ONE,
  '',
  '```bash',
  CODE_LINE,
  'echo "ok"',
  '```',
  '',
  ...Array.from({ length: 80 }, (_, i) => `Detail line ${i + 1}: ${SECTION_TWO}`),
  '',
  '```ts',
  'export const retryDelay = (n: number) => Math.min(300_000, 2 ** n * 1000);',
  '```',
  SECTION_THREE,
  LAST_LINE,
].join('\n');

const long = makeReport({ id: 'rep_1', taskTitle: 'Add retry to the sync job', body });

async function open(core = createFakeCore({ reportBodies: { rep_1: long } })) {
  setParams({ id: 'rep_1' });
  return mount(<ReportDetailScreen />, { core });
}

describe('report detail', () => {
  it('renders the full report text, selectable, with code blocks in monospace', async () => {
    await open();
    expect(await screen.findByText('Copy report')).toBeOnTheScreen();

    for (const piece of [SECTION_ONE, SECTION_THREE, LAST_LINE]) {
      expect(screen.getByText(piece, { exact: false })).toBeOnTheScreen();
    }
    // Chunked rendering must not drop anything: every detail line is somewhere on screen.
    for (const n of [1, 40, 80]) expect(screen.getByText(`Detail line ${n}:`, { exact: false })).toBeOnTheScreen();

    const code = screen.getByText(CODE_LINE, { exact: false });
    expect(code.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ fontFamily: 'monospace' })]));
    expect(code.props.selectable).toBe(true);
    expect(screen.getByText(SECTION_ONE, { exact: false }).props.selectable).toBe(true);
  });

  it('says the status is declared by Claude and not verified, and shows project and session', async () => {
    await open();
    await screen.findByText('Copy report');
    expect(screen.getByText('Declared complete by Claude, not verified')).toBeOnTheScreen();
    expect(screen.getByText(/GitManager, session a1b2c3d4/)).toBeOnTheScreen();
  });

  it('copies exactly the full body', async () => {
    await open();
    await fireEvent.press(await screen.findByText('Copy report'));
    await flush();
    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(body);
    expect(screen.getByText('Report copied')).toBeOnTheScreen();
  });

  it('shares exactly the full body', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await open();
    await fireEvent.press(await screen.findByText('More'));
    await fireEvent.press(await screen.findByText('Share'));
    await flush();
    expect(share).toHaveBeenCalledWith({ title: 'Add retry to the sync job', message: body });
  });

  it('never writes the report to storage', async () => {
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await open();
    await fireEvent.press(await screen.findByText('Copy report'));
    await fireEvent.press(await screen.findByText('More'));
    await fireEvent.press(await screen.findByText('Share'));
    await flush();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('marks the report as read through the desktop and updates what the phone shows', async () => {
    const { core, manager } = await open();
    await fireEvent.press(await screen.findByText('More'));
    await fireEvent.press(await screen.findByText('Mark as read'));
    await flush();
    expect(core.calls('POST /reports/:id/read')).toHaveLength(1);
    expect(manager.getSnapshot().state.reports.find((r) => r.id === 'rep_1')?.read).toBe(true);
  });

  it('opens the conversation frozen into the delivery, not the project default', async () => {
    const open$ = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const frozen = 'https://chatgpt.com/c/99999999-8888-4777-8666-555555555555';
    const core = createFakeCore({
      reportBodies: { rep_1: long },
      deliveries: [makeDelivery({ destination: { ...makeDelivery().destination!, url: frozen, title: 'Release notes chat' } })],
    });
    await open(core);
    await fireEvent.press(await screen.findByText('Open linked ChatGPT conversation'));
    expect(open$).toHaveBeenCalledWith(frozen);
    expect(screen.getByText(/the conversation chosen when this report arrived/)).toBeOnTheScreen();
  });

  it("falls back to the project's preferred conversation when no destination was frozen", async () => {
    const open$ = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const core = createFakeCore({ reportBodies: { rep_1: long }, deliveries: [makeDelivery({ destination: null })] });
    await open(core);
    await fireEvent.press(await screen.findByText('Open linked ChatGPT conversation'));
    expect(open$).toHaveBeenCalledWith(makeConversation().url);
    expect(screen.getByText(/preferred conversation/)).toBeOnTheScreen();
  });

  it('refuses to open an address that is not a ChatGPT conversation', async () => {
    const open$ = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const core = createFakeCore({
      reportBodies: { rep_1: long },
      deliveries: [makeDelivery({ destination: { ...makeDelivery().destination!, url: 'intent://evil#Intent;scheme=http;end' } })],
      snapshot: makeSnapshot({ projects: [makeProject({ preferredConversationId: null })] }),
    });
    await open(core);
    await flush();
    expect(screen.queryByText('Open linked ChatGPT conversation')).toBeNull();
    expect(open$).not.toHaveBeenCalled();
  });

  it('says so when the report is gone, and offers a retry when the desktop cannot be reached', async () => {
    const gone = createFakeCore({ reportBodies: {} });
    setParams({ id: 'rep_1' });
    await mount(<ReportDetailScreen />, { core: gone });
    expect(await screen.findByText('This report is no longer on your PC.')).toBeOnTheScreen();
  });

  it('shows a retry when the full text cannot be loaded', async () => {
    const core = createFakeCore({ reportBodies: { rep_1: long } });
    core.on('GET /reports/:id', () => 'network-error');
    await open(core);
    expect(await screen.findByText('Try again')).toBeOnTheScreen();
    expect(screen.getByText(/Could not load the report/)).toBeOnTheScreen();
    core.on('GET /reports/:id', () => ({ body: long }));
    await fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('Copy report')).toBeOnTheScreen();
  });
});

describe('reports list', () => {
  it('shows title, declared status, project, time and delivery state, and opens a report', async () => {
    const core = createFakeCore({
      reports: [makeSummary({ id: 'rep_1', taskTitle: 'Add retry to the sync job' }), makeSummary({ id: 'rep_2', taskTitle: 'Fix flaky test', declaredStatus: 'partial', read: true, delivery: null })],
    });
    await mount(<ReportsScreen />, { core });
    expect(screen.getByText('Add retry to the sync job')).toBeOnTheScreen();
    expect(screen.getByText('Declared complete by Claude, not verified')).toBeOnTheScreen();
    expect(screen.getByText('Declared partial by Claude, not verified')).toBeOnTheScreen();
    expect(screen.getAllByText(/Ready to hand off on your PC/).length).toBe(1);
    expect(screen.getByText(/No ChatGPT handoff yet/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Fix flaky test'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/report', params: { id: 'rep_2' } });
  });
});
