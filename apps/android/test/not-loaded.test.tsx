// Every screen must render something sensible before the first snapshot has arrived (and when the desktop never answers),
// never an empty crash and never old-looking data presented as current.
import type { ReactElement } from 'react';
import { screen } from '@testing-library/react-native';
import { ActivityScreen } from '../src/screens/Activity';
import { HomeScreen } from '../src/screens/Home';
import { InboxScreen } from '../src/screens/Inbox';
import { ProjectDetailScreen } from '../src/screens/ProjectDetail';
import { RemoteControlScreen } from '../src/screens/RemoteControl';
import { ReportsScreen } from '../src/screens/Reports';
import { SendToClaudeScreen } from '../src/screens/SendToClaude';
import { SessionDetailScreen } from '../src/screens/SessionDetail';
import { setParams } from './mocks/expo-router';
import { SESSION_KEY } from './helpers/data';
import { createFakeCore } from './helpers/fakeCore';
import { mount } from './helpers/render';

const screens: [string, ReactElement, Record<string, string>][] = [
  ['Home', <HomeScreen />, {}],
  ['Activity', <ActivityScreen />, {}],
  ['Inbox', <InboxScreen />, {}],
  ['Reports', <ReportsScreen />, {}],
  ['Project', <ProjectDetailScreen />, { id: 'prj_1' }],
  ['Session', <SessionDetailScreen />, { key: SESSION_KEY }],
  ['Send to Claude', <SendToClaudeScreen />, { key: SESSION_KEY }],
  ['Remote Control', <RemoteControlScreen />, { key: SESSION_KEY }],
];

describe('before the first snapshot', () => {
  it.each(screens)('%s renders and the banner says it is connecting', async (_name, ui, params) => {
    setParams(params);
    await mount(ui, { core: createFakeCore(), connect: false });
    expect(screen.getByText("Connecting to Farmaan's PC")).toBeOnTheScreen();
    expect(screen.queryByText('Last updated', { exact: false })).toBeNull();
  });
});
