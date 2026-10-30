import * as ExpoLinking from 'expo-linking';
import { useCameraPermissions } from 'expo-camera';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { encodePairingPayload } from '@minisumma/shared';
import { SessionProvider } from '../src/session/SessionProvider';
import { PairScreen } from '../src/screens/Pair';
import type { CredentialStore, Credentials } from '../src/connection/credentials';
import { createFakeCore } from './helpers/fakeCore';
import { flush } from './helpers/render';
import { ConnectionManager } from '../src/connection/ConnectionManager';

const payload = { version: 1 as const, code: 'abcDEF123456', offerId: 'off_1', name: "Farmaan's PC", urls: ['https://pc.tail1234.ts.net'] };

function memoryStore(): CredentialStore & { saved: Credentials[] } {
  const saved: Credentials[] = [];
  return { saved, load: jest.fn(async () => null), save: jest.fn(async (c: Credentials) => { saved.push(c); }), clear: jest.fn(async () => undefined) };
}

async function mountPair(core = createFakeCore(), store = memoryStore()) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = core.fetch;
  const utils = await render(
    <SessionProvider store={store} createManager={(c, onRevoked) => new ConnectionManager({ credentials: c, fetch: core.fetch, WebSocket: core.WebSocket, onRevoked })}>
      <PairScreen />
    </SessionProvider>,
  );
  await flush();
  return { core, store, utils, restore: () => { globalThis.fetch = realFetch; } };
}

const scan = async (data: string) => {
  await act(async () => { screen.getByTestId('camera-view').props.onBarcodeScanned({ data, type: 'qr' }); });
  await flush(2);
};

describe('pairing screen: scanning', () => {
  it('shows what was scanned and pairs only after the person confirms, then stores the credentials', async () => {
    const { core, store, restore } = await mountPair();
    await scan(encodePairingPayload(payload));
    expect(screen.getByText("Farmaan's PC")).toBeOnTheScreen();
    expect(screen.getByText('https://pc.tail1234.ts.net')).toBeOnTheScreen();
    expect(core.calls('POST /pairing/redeem')).toHaveLength(0); // nothing is sent before the confirmation

    await fireEvent.press(screen.getByText("Pair with Farmaan's PC"));
    await flush();
    expect(core.calls('POST /pairing/redeem')).toHaveLength(1);
    expect(core.calls('POST /pairing/redeem')[0].body).toMatchObject({ offerId: 'off_1', code: 'abcDEF123456', platform: 'android' });
    expect(store.saved).toEqual([{ baseUrl: 'https://pc.tail1234.ts.net', token: 'bearer-from-pairing', deviceId: 'dev_1', serverName: "Farmaan's PC" }]);
    restore();
  });

  it('ignores a QR code that is not a Mini-Summa pairing code and says so', async () => {
    const { store, restore } = await mountPair();
    await scan('https://example.com/not-ours');
    expect(screen.getByText('That QR code is not a Mini-Summa pairing code.')).toBeOnTheScreen();
    expect(screen.queryByText(/Pair with/)).toBeNull();
    expect(store.saved).toHaveLength(0);
    restore();
  });

  it('shows the plain reason when the code has expired and stores nothing', async () => {
    const core = createFakeCore();
    core.on('POST /pairing/redeem', () => ({ status: 410, body: { error: { code: 'offer_expired', message: 'This pairing offer has expired.' } } }));
    const { store, restore } = await mountPair(core);
    await scan(encodePairingPayload(payload));
    await fireEvent.press(screen.getByText("Pair with Farmaan's PC"));
    await flush();
    expect(screen.getByTestId('pair-error')).toBeOnTheScreen();
    expect(screen.getByText(/pairing code has expired/)).toBeOnTheScreen();
    expect(store.saved).toHaveLength(0);
    restore();
  });

  it('says the PC may be asleep, offline or not on Tailscale when no address answers', async () => {
    const core = createFakeCore();
    core.setOffline(true);
    const { restore } = await mountPair(core);
    await scan(encodePairingPayload(payload));
    await fireEvent.press(screen.getByText("Pair with Farmaan's PC"));
    await flush();
    expect(screen.getByText(/Your PC may be asleep, offline, or not signed in to Tailscale on this phone/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Show details'));
    expect(screen.getByText('https://pc.tail1234.ts.net: no answer')).toBeOnTheScreen();
    restore();
  });

  it('shows the removal notice when the desktop removed this phone earlier', async () => {
    const core = createFakeCore();
    const store = memoryStore();
    (store.load as jest.Mock).mockResolvedValueOnce({ baseUrl: 'https://pc.tail1234.ts.net', token: 't', deviceId: 'dev_1', serverName: 'PC' });
    core.on('GET /state', () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Authentication required.' } } }));
    const { restore } = await mountPair(core, store);
    await act(async () => { core.connect(); });
    await flush();
    expect(screen.getByTestId('pair-notice')).toBeOnTheScreen();
    expect(screen.getByText('This phone was removed in Mini-Summa. Pair again.')).toBeOnTheScreen();
    restore();
  });

  it('picks up a minisumma://pair link opened from outside the app', async () => {
    (ExpoLinking.useURL as jest.Mock).mockReturnValue(encodePairingPayload(payload));
    const { restore } = await mountPair();
    expect(screen.getByText("Pair with Farmaan's PC")).toBeOnTheScreen();
    (ExpoLinking.useURL as jest.Mock).mockReturnValue(null);
    restore();
  });
});

describe('pairing screen: camera permission and manual entry', () => {
  afterEach(() => {
    (useCameraPermissions as jest.Mock).mockImplementation(() => [{ granted: true, canAskAgain: true }, jest.fn(async () => ({ granted: true }))]);
  });

  it('asks for the camera, and explains how to change it when the question can no longer be asked', async () => {
    (useCameraPermissions as jest.Mock).mockReturnValue([{ granted: false, canAskAgain: true }, jest.fn()]);
    const first = await mountPair();
    expect(screen.getByText('Allow camera')).toBeOnTheScreen();
    first.restore();
    await first.utils.unmount();

    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    (useCameraPermissions as jest.Mock).mockReturnValue([{ granted: false, canAskAgain: false }, jest.fn()]);
    const second = await mountPair();
    expect(screen.getByText(/Camera access is off for Mini-Summa/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Open Android settings'));
    expect(open).toHaveBeenCalled();
    second.restore();
  });

  it('pairs from an address, offer ID and code typed by hand', async () => {
    const { core, store, restore } = await mountPair();
    await fireEvent.press(screen.getByText('Enter the code by hand'));
    await fireEvent.changeText(screen.getByLabelText('Address of your PC'), 'pc.tail1234.ts.net');
    await fireEvent.changeText(screen.getByLabelText('Offer ID'), 'off_1');
    await fireEvent.changeText(screen.getByLabelText('Pairing code'), 'abcDEF123456');
    await fireEvent.press(screen.getByText('Pair'));
    await flush();
    expect(core.calls('POST /pairing/redeem')[0].body).toMatchObject({ offerId: 'off_1', code: 'abcDEF123456' });
    expect(store.saved[0].baseUrl).toBe('https://pc.tail1234.ts.net');
    restore();
  });

  it('a pairing link pasted into a field fills everything and goes to the confirmation', async () => {
    const { restore } = await mountPair();
    await fireEvent.press(screen.getByText('Enter the code by hand'));
    await fireEvent.changeText(screen.getByLabelText('Pairing code'), encodePairingPayload(payload));
    expect(screen.getByText("Pair with Farmaan's PC")).toBeOnTheScreen();
    restore();
  });

  it('tells the person what is missing instead of sending a half-filled form', async () => {
    const { core, restore } = await mountPair();
    await fireEvent.press(screen.getByText('Enter the code by hand'));
    await fireEvent.press(screen.getByText('Pair'));
    await flush();
    expect(screen.getByText(/Check the address, offer ID and pairing code/)).toBeOnTheScreen();
    expect(core.requests).toHaveLength(0);
    restore();
  });
});
