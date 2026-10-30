// IPC channel names shared by the main process and the preload. Plain constants only: the sandboxed preload bundle
// imports this file and must not pull anything else in.
export const CH = {
  connection: 'ms:connection',
  chatgptSetBounds: 'ms:chatgpt:setBounds',
  chatgptSetOverlayActive: 'ms:chatgpt:setOverlayActive',
  chatgptNavigate: 'ms:chatgpt:navigate',
  chatgptReload: 'ms:chatgpt:reload',
  chatgptBack: 'ms:chatgpt:back',
  chatgptForward: 'ms:chatgpt:forward',
  chatgptFocus: 'ms:chatgpt:focus',
  chatgptGetState: 'ms:chatgpt:getState',
  clipboardWriteText: 'ms:clipboard:writeText',
  selectDirectory: 'ms:dialogs:selectDirectory',
  openExternal: 'ms:shell:openExternal',
  showItemInFolder: 'ms:shell:showItemInFolder',
  setBadgeCount: 'ms:app:setBadgeCount',
  getPaths: 'ms:app:getPaths',
  /** main -> renderer events */
  chatgptState: 'ms:chatgpt:state',
  navigate: 'ms:app:navigate',
} as const;

/** Channels the renderer may invoke. Everything else is main -> renderer. */
export const INVOKE_CHANNELS = [
  CH.connection, CH.chatgptSetBounds, CH.chatgptSetOverlayActive, CH.chatgptNavigate, CH.chatgptReload, CH.chatgptBack,
  CH.chatgptForward, CH.chatgptFocus, CH.chatgptGetState, CH.clipboardWriteText, CH.selectDirectory, CH.openExternal,
  CH.showItemInFolder, CH.setBadgeCount, CH.getPaths,
] as const;

/** Name of the process argument that carries the app version into the sandboxed preload (it cannot ask `app`). */
export const VERSION_ARG_PREFIX = '--minisumma-version=';
