// Options page: the DOM side. The logic is in options-controller.ts.
import { createOptionsController } from './options-controller.ts';
import type { OptionsFields, OptionsModel, OptionsView } from './options-controller.ts';
import { deviceNameFromNavigator } from './pairing.ts';
import type { NavigatorInfo } from './pairing.ts';
import type { BackgroundRequest, BackgroundResponse, ConnectionStatus } from './status.ts';

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`The options page is missing #${id}`);
  return el as T;
};

const el = {
  headline: byId('status-headline'),
  detail: byId('status-detail'),
  coreUrl: byId<HTMLInputElement>('core-url'),
  saveAddress: byId<HTMLButtonElement>('save-address'),
  form: byId<HTMLFormElement>('pair-form'),
  link: byId<HTMLInputElement>('link'),
  offerId: byId<HTMLInputElement>('offer-id'),
  code: byId<HTMLInputElement>('code'),
  deviceName: byId<HTMLInputElement>('device-name'),
  message: byId('message'),
  pair: byId<HTMLButtonElement>('pair'),
  spinner: byId('pair-spinner'),
  paired: byId('paired'),
  pairedLine: byId('paired-line'),
  unpair: byId<HTMLButtonElement>('unpair'),
};

const inputs: Record<keyof OptionsFields, HTMLInputElement> = {
  coreUrl: el.coreUrl, link: el.link, offerId: el.offerId, code: el.code, deviceName: el.deviceName,
};

const view: OptionsView = {
  readFields: () => ({ coreUrl: el.coreUrl.value, link: el.link.value, offerId: el.offerId.value, code: el.code.value, deviceName: el.deviceName.value }),
  writeFields(patch) {
    for (const key of Object.keys(patch) as (keyof OptionsFields)[]) inputs[key].value = patch[key] ?? '';
  },
  render(m: OptionsModel) {
    el.headline.textContent = m.statusText.headline;
    el.detail.textContent = m.statusText.detail;
    el.detail.hidden = m.statusText.detail === '';
    el.form.hidden = m.paired;
    el.paired.hidden = !m.paired;
    el.pairedLine.textContent = m.pairedLine ?? '';
    el.saveAddress.hidden = !m.addressDirty;
    el.pair.disabled = m.busy;
    el.pair.setAttribute('aria-busy', String(m.busy));
    el.spinner.hidden = !m.busy;
    el.message.hidden = m.message === null;
    el.message.textContent = m.message?.text ?? '';
    el.message.dataset.kind = m.message?.kind ?? '';
  },
};

async function requestStatus(): Promise<ConnectionStatus | null> {
  try {
    const request: BackgroundRequest = { type: 'get-status' };
    const response = (await chrome.runtime.sendMessage(request)) as BackgroundResponse | undefined;
    return response?.type === 'status' ? response.status : null;
  } catch {
    return null;
  }
}

const controller = createOptionsController({
  area: chrome.storage.local,
  fetch: (input, init) => fetch(input, init),
  requestStatus,
  defaultDeviceName: deviceNameFromNavigator(navigator as unknown as NavigatorInfo),
  now: () => Date.now(),
  view,
});

for (const input of [el.coreUrl, el.offerId, el.code, el.deviceName]) input.addEventListener('input', () => controller.onInput());
el.link.addEventListener('input', () => controller.onLinkInput());
el.form.addEventListener('submit', (event) => { event.preventDefault(); void controller.pair(); });
el.saveAddress.addEventListener('click', () => { void controller.saveAddress(); });
el.unpair.addEventListener('click', () => { void controller.unpair(); });
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') void controller.refresh(); });

void controller.init();
// The status is read from the live worker, so poll while the page is visible. This also wakes a sleeping worker.
setInterval(() => { if (document.visibilityState === 'visible') void controller.refresh(); }, 1000);
