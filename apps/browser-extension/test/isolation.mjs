// The rules that keep every test browser away from the real internet, in a module with no heavy imports so that a unit
// test can check them. test/support.mjs (launchBrowser) and test/keepalive.mjs use them.

/** The ChatGPT names the stand-in answers to. These are the only ChatGPT addresses any test ever uses. */
export const STAND_IN_HOSTS = ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'];
/** A site that is not ChatGPT, answered by the same stand-in, to check what the extension may and may not see. */
export const OTHER_SITE_HOST = 'accounts.other-site.example';
export const STAND_IN_NAMES = [...STAND_IN_HOSTS, OTHER_SITE_HOST];
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

/** The stand-in names go to the local server, every other name does not exist, loopback is left alone. */
export function hostResolverRules(standInPort) {
  return [
    ...STAND_IN_NAMES.map((h) => `MAP ${h} 127.0.0.1:${standInPort}`),
    'MAP * ~NOTFOUND',
    ...LOOPBACK_HOSTS.map((h) => `EXCLUDE ${h}`),
  ].join(', ');
}

/** A public name that is not a ChatGPT name and that must never resolve while the rules are in force. */
export const CANARY_URL = 'https://example.com/';

/** The only acceptable outcome of navigating to CANARY_URL. Anything else, including success, means the rules are not in force. */
export const CANARY_EXPECTED = /ERR_NAME_NOT_RESOLVED/;

export function isolationFailure(outcome) {
  return new Error(`NETWORK ISOLATION IS NOT IN FORCE: navigating to ${CANARY_URL} ended with "${String(outcome).split('\n')[0]}" instead of a name resolution failure. `
    + 'Stopping before any ChatGPT address is used.');
}
