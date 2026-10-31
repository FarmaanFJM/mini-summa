// Connection status as the background worker reports it and the options page shows it.

export type ConnectionStatus =
  | { state: 'not_paired'; since: number; coreUrl: string }
  /** Mini-Summa closed the connection with code 4003: this browser was unpaired there and the token was dropped. */
  | { state: 'revoked'; since: number; coreUrl: string }
  | { state: 'connecting'; since: number; coreUrl: string; attempt: number }
  | { state: 'connected'; since: number; coreUrl: string; scopes: string[]; canAnswer: boolean }
  | { state: 'unreachable'; since: number; coreUrl: string; attempt: number; retryAt: number; detail: string | null };

/** Messages from a page of the extension to the background worker. */
export type BackgroundRequest = { type: 'get-status' };
export type BackgroundResponse = { type: 'status'; status: ConnectionStatus };

export interface StatusText { headline: string; detail: string }

/** Plain sentences for the options page. No em dashes: they are user-facing copy. */
export function describeStatus(status: ConnectionStatus, now: number): StatusText {
  switch (status.state) {
    case 'not_paired':
      return { headline: 'Not paired', detail: 'Create a pairing code in Mini-Summa under Settings, Browser extension, then pair this browser below.' };
    case 'revoked':
      return { headline: 'This browser was unpaired in Mini-Summa', detail: 'Create a new pairing code in Mini-Summa to connect again.' };
    case 'connecting':
      return { headline: 'Connecting', detail: `Contacting Mini-Summa at ${status.coreUrl}.` };
    case 'connected':
      return status.canAnswer
        ? { headline: 'Connected', detail: `Mini-Summa at ${status.coreUrl} can ask this browser to bring a ChatGPT tab forward.` }
        : { headline: 'Connected, but not allowed to answer', detail: 'This pairing was not created for the browser extension. Create a new code under Settings, Browser extension in Mini-Summa and pair again.' };
    case 'unreachable': {
      const seconds = Math.max(0, Math.ceil((status.retryAt - now) / 1000));
      const why = status.detail ? `${status.detail} ` : '';
      return { headline: 'Mini-Summa is not reachable', detail: `${why}Is the app running? Trying ${status.coreUrl} again in ${seconds} s.` };
    }
  }
}
