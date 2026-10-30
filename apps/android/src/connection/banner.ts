// What the connection banner says. The banner is shown whenever the data on screen is not live, so a stale list can
// never pass for current. When the Tailscale address does not answer, the likely cause (PC asleep or off) is stated.
import { formatWhen } from '../lib/format.ts';
import { REVOKED_MESSAGE } from '../lib/errors.ts';
import type { ConnectionSnapshot } from './ConnectionManager.ts';

export interface BannerModel {
  visible: boolean;
  tone: 'neutral' | 'warning' | 'danger';
  title: string;
  detail: string | null;
  /** "Last updated 14:32", present whenever data is on screen that is not live. */
  lastUpdated: string | null;
}

const HIDDEN: BannerModel = { visible: false, tone: 'neutral', title: '', detail: null, lastUpdated: null };

type BannerInput = Pick<ConnectionSnapshot, 'status' | 'cause' | 'lastError' | 'lastHeardAt' | 'endpoint'> & { state: { loaded: boolean } };

export function describeConnection(s: BannerInput, now: Date = new Date()): BannerModel {
  if (s.status === 'connected') return HIDDEN;
  const hasData = s.state.loaded;
  const lastUpdated = hasData && s.lastHeardAt ? `Last updated ${formatWhen(s.lastHeardAt, now)}` : null;
  const stale = hasData ? ' What you see below is not live.' : '';

  switch (s.status) {
    case 'revoked':
      return { visible: true, tone: 'danger', title: REVOKED_MESSAGE, detail: null, lastUpdated: null };
    case 'connecting':
      return { visible: true, tone: 'neutral', title: `Connecting to ${s.endpoint.serverName || 'your PC'}`, detail: null, lastUpdated: null };
    case 'reconnecting':
      return { visible: true, tone: 'warning', title: 'Reconnecting to your PC', detail: `Waiting for live updates.${stale}`, lastUpdated };
    case 'idle':
      return hasData
        ? { visible: true, tone: 'warning', title: 'Not connected', detail: `Live updates are paused.${stale}`, lastUpdated }
        : HIDDEN;
    case 'desktop_unreachable': {
      if (s.cause === 'server_error') {
        return {
          visible: true, tone: 'warning', title: 'Mini-Summa on your PC is not responding',
          detail: `Your PC answered, but Mini-Summa returned an error${s.lastError ? ` (${s.lastError})` : ''}. It may be starting up or closed.${stale}`,
          lastUpdated,
        };
      }
      if (s.cause === 'stream_blocked') {
        return {
          visible: true, tone: 'warning', title: 'Live updates cannot connect',
          detail: `Your PC answers, but the live connection does not open. Pull down to refresh.${stale}`, lastUpdated,
        };
      }
      return {
        visible: true, tone: 'warning', title: 'Cannot reach your PC',
        detail: `Your PC did not answer. It is most likely asleep or turned off. It may also be offline, or this phone may not be signed in to Tailscale.${stale}`,
        lastUpdated,
      };
    }
  }
}
