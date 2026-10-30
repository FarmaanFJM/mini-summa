// The logic of the options page, separated from the DOM so it can be tested with a fake view, a fake fetch and an
// in-memory storage area. options.ts supplies the real ones.
import { decodePairingPayload } from '@minisumma/shared';
import { DEFAULT_CORE_URL, normalizeCoreUrl } from './core-address.ts';
import { redeemPairing, resolvePairingForm } from './pairing.ts';
import { describeStatus } from './status.ts';
import type { ConnectionStatus, StatusText } from './status.ts';
import { clearPairing, loadState, saveCoreUrl, savePairing, toPublicState } from './storage.ts';
import type { PublicState, StorageAreaLike } from './storage.ts';

export interface OptionsFields { coreUrl: string; link: string; offerId: string; code: string; deviceName: string }

export interface OptionsModel {
  statusText: StatusText;
  paired: boolean;
  /** "Paired as Chrome on Windows" while paired. */
  pairedLine: string | null;
  /** The address field differs from the saved address, so a Save button is useful. */
  addressDirty: boolean;
  busy: boolean;
  message: { kind: 'error' | 'info'; text: string } | null;
}

export interface OptionsView {
  /** Update text, visibility and disabled state only. Never touch field values here, the person may be typing. */
  render(model: OptionsModel): void;
  readFields(): OptionsFields;
  writeFields(patch: Partial<OptionsFields>): void;
}

export interface OptionsDeps {
  area: StorageAreaLike;
  fetch: typeof fetch;
  /** Ask the background worker for its live status; null when it does not answer. */
  requestStatus(): Promise<ConnectionStatus | null>;
  defaultDeviceName: string;
  now(): number;
  view: OptionsView;
}

export interface OptionsController {
  init(): Promise<void>;
  refresh(): Promise<void>;
  /** The person typed or pasted into any field. */
  onInput(): void;
  /** The pairing link field changed: fill the other fields from it when it is valid. */
  onLinkInput(): void;
  pair(): Promise<void>;
  unpair(): Promise<void>;
  saveAddress(): Promise<void>;
}

export function createOptionsController(deps: OptionsDeps): OptionsController {
  const { view, area } = deps;
  let stored: PublicState = { coreUrl: DEFAULT_CORE_URL, deviceId: null, deviceName: null, pairedAt: null, revokedAt: null, paired: false };
  let status: ConnectionStatus | null = null;
  let answered = false;
  let busy = false;
  let message: OptionsModel['message'] = null;

  const render = (): void => {
    const fields = view.readFields();
    const checked = normalizeCoreUrl(fields.coreUrl);
    const dirty = stored.paired && fields.coreUrl.trim() !== '' && (!checked.ok || checked.url !== stored.coreUrl);
    const statusText: StatusText = status
      ? describeStatus(status, deps.now())
      : answered
        ? { headline: 'The extension did not answer', detail: 'Reload the extension on the extensions page (chrome://extensions) and open this page again.' }
        : { headline: 'Checking', detail: '' };
    view.render({
      statusText,
      paired: stored.paired,
      pairedLine: stored.paired ? `Paired as ${stored.deviceName ?? 'this browser'}.` : null,
      addressDirty: dirty,
      busy,
      message,
    });
  };

  const refresh = async (): Promise<void> => {
    stored = toPublicState(await loadState(area));
    status = await deps.requestStatus();
    answered = true;
    render();
  };

  return {
    async init() {
      stored = toPublicState(await loadState(area));
      view.writeFields({ coreUrl: stored.coreUrl, deviceName: deps.defaultDeviceName });
      await refresh();
    },
    refresh,
    onInput() { render(); },

    onLinkInput() {
      const payload = decodePairingPayload(view.readFields().link);
      if (payload) {
        const local = payload.urls.map(normalizeCoreUrl).find((r) => r.ok);
        view.writeFields({ offerId: payload.offerId, code: payload.code, ...(local?.ok ? { coreUrl: local.url } : {}) });
        message = null;
      }
      render();
    },

    async pair() {
      if (busy) return;
      const fields = view.readFields();
      const form = resolvePairingForm({ ...fields, deviceName: fields.deviceName || deps.defaultDeviceName });
      if (!form.ok) { message = { kind: 'error', text: form.message }; render(); return; }
      busy = true; message = null; render();
      const result = await redeemPairing(form, { fetch: deps.fetch });
      busy = false;
      if (!result.ok) { message = { kind: 'error', text: result.message }; render(); return; }
      await savePairing(area, { coreUrl: result.coreUrl, token: result.token, deviceId: result.deviceId, deviceName: result.deviceName, pairedAt: deps.now() });
      // The one-time code is spent; do not leave it sitting in the page.
      view.writeFields({ link: '', offerId: '', code: '', coreUrl: result.coreUrl });
      message = null;
      await refresh();
    },

    async unpair() {
      await clearPairing(area);
      message = null;
      await refresh();
    },

    async saveAddress() {
      const checked = normalizeCoreUrl(view.readFields().coreUrl);
      if (!checked.ok) { message = { kind: 'error', text: checked.message }; render(); return; }
      await saveCoreUrl(area, checked.url);
      view.writeFields({ coreUrl: checked.url });
      message = null;
      await refresh();
    },
  };
}
