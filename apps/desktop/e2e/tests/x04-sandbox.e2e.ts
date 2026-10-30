// Not one of the 25 behaviours: a check of the suite's own promise. Nothing a test does may reach a real host. The app is started with
// host rules that send chatgpt.com to a local stand-in and every other name to "not found"; this proves that they hold, from inside the
// app, for the two kinds of network session it has (its default one, and the one the embedded ChatGPT view uses).
import { expect } from 'vitest';
import { launchApp } from '../helpers/app.ts';
import { evidence } from '../helpers/evidence.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';

const OTHER_HOSTS = ['https://example.org/', 'http://example.com/', 'https://www.google.com/', 'https://api.openai.com/v1/models', 'https://chat.openai.com/', 'https://auth.openai.com/'];

scenario('[X04] The test sandbox is closed: the app reaches the chatgpt.com stand-in and no other host', async () => {
  const h = await launchApp();

  // Every other host name fails to resolve, in both sessions, and nothing arrives at the stand-in for them.
  const attempts = await h.app.evaluate(async ({ session }, urls) => {
    const outcomes: Record<string, string> = {};
    for (const [label, ses] of [['default session', session.defaultSession], ['ChatGPT view session', session.fromPartition('persist:chatgpt')]] as const) {
      for (const url of urls) {
        try { const response = await ses.fetch(url); outcomes[`${label}: ${url}`] = `REACHED, status ${response.status}`; }
        catch (error) { outcomes[`${label}: ${url}`] = (error as Error).message; }
      }
    }
    return outcomes;
  }, OTHER_HOSTS);
  expect(Object.keys(attempts)).toHaveLength(OTHER_HOSTS.length * 2);
  for (const [attempt, outcome] of Object.entries(attempts)) expect(outcome, attempt).toContain('ERR_NAME_NOT_RESOLVED');
  expect(h.standIn.requests, 'nothing for another host reached the stand-in').toEqual([]);

  // chatgpt.com itself is the stand-in: the request is answered by it, and recorded as a GET for chatgpt.com.
  const url = conversationUrl(uuidOf('x04'));
  const reached = await h.app.evaluate(async ({ session }, target) => {
    const response = await session.fromPartition('persist:chatgpt').fetch(target);
    return { status: response.status, text: (await response.text()).length };
  }, url);
  expect(reached.status).toBe(200);
  expect(h.standIn.requests.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([`GET chatgpt.com/c/${uuidOf('x04')}`]);
  evidence('X04', `${OTHER_HOSTS.length} other host names (example.org, example.com, google.com, three openai.com names) all failed with net::ERR_NAME_NOT_RESOLVED from both of the app's network sessions, and none of the ${OTHER_HOSTS.length * 2} attempts reached the stand-in; chatgpt.com answered with status ${reached.status} from the stand-in and was recorded as one GET. Host names only: an address typed as an IP number is not covered by host rules, and no test uses one`);
});
