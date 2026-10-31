// Decides which page of ChatGPT is worth remembering for a project. Pure logic, no React, no timers: the ChatGPT pane feeds it the
// states of the embedded view and writes down what it returns (route.selectChatGptUrl, which uiSync keeps in the core).
//
// What is remembered is "the last page the person was on in THIS project in Mini-Summa". It is read from the view's address only
// (the view reports an address, a title and a status; nothing in the page is ever read).
//
//  * Only a conversation or the page of a ChatGPT Project counts. The home page, settings, sign-in, a share link or a page that
//    is still loading or failed to load is never recorded (`rememberableChatGptUrl`, status 'ready').
//  * A project linked to a ChatGPT Project whose address has a scope (`g-p-...`) records only that project's pages. A project
//    without a link, or linked by an address of a form that is not recognised, records conversations.
//  * The project-switch race. Between the moment another project is selected and the moment its page is on screen, the one embedded
//    view still shows the previous project's page and goes on reporting it. Whatever it reports then must not be recorded for the new
//    project. A new owner therefore starts DISARMED and is armed only when the view has loaded the address this project asked for, or,
//    when it was not asked for anything, once the view reports an address other than the one it showed when the owner began (the
//    person navigated). With live views (one per project) the view of a project only ever shows that project's pages, so an owner is
//    armed at once when the view already has a page.
//  * Nothing here ever maps a conversation to a project as a report destination or creates a project.
import { parseChatGptUrl, rememberableChatGptUrl, sameChatGptPage } from '@minisumma/shared';
import type { ChatGptViewState } from '@minisumma/shared';

export interface RecordedProject {
  id: string;
  /** The `g-p-...` segment of the linked ChatGPT Project's address, or null (not linked, or an address of another form). */
  scopeId: string | null;
}

/** The plain address to remember for this project, or null when this page is not one to remember for it. */
export function recordableAddress(url: string | null, project: RecordedProject): string | null {
  if (url === null) return null;
  const plain = rememberableChatGptUrl(url);
  if (plain === null) return null;
  if (project.scopeId === null) {
    const read = parseChatGptUrl(plain);
    return read.ok && read.info.chatgptConversationId !== null ? plain : null; // a project page of some other ChatGPT Project is not this project's
  }
  const read = parseChatGptUrl(plain);
  return read.ok && read.info.scopeId === project.scopeId && (read.info.kind === 'project' || read.info.kind === 'project_chat') ? plain : null;
}

/**
 * How long after the view reached (or was sent away from) the page a restore asked for, a different address counts as ChatGPT's own
 * redirect and not as the person's choice. A redirect (a conversation that no longer exists, an expired sign-in, an outage page) must
 * never replace the remembered last page: only a page the person navigated to, or the page the restore asked for, is recorded.
 */
export const RESTORE_GRACE_MS = 5000;

interface Owner {
  token: number;
  project: RecordedProject;
  /** The address the view showed when this owner began: whatever it still reports is the previous owner's page. */
  stale: string | null;
  /** The address this project asked the view to load, until the view has shown it. */
  requested: string | null;
  /** The address that was asked for, kept after a redirect so that arriving there later (after signing in) is recorded. */
  wanted: string | null;
  armed: boolean;
  /** The first address after the request (the page itself, or where ChatGPT sent the view instead), and until when others are redirects. */
  anchor: string | null;
  graceUntil: number;
  /** ChatGPT showed another page than the one asked for. Nothing was recorded for it. */
  missed: string | null;
  /** The anchor is a page ChatGPT sent the view to instead of the one asked for: it is not recorded for as long as the view stays on it. */
  landing: boolean;
  /** The request is the restore of a remembered last page: that address is protected from being replaced by a redirect. */
  protect: boolean;
}

export class ChatGptRecorder {
  private owner: Owner | null = null;
  private tokens = 0;
  /** The latest address the view reported, whoever owned it. */
  private lastSeen: string | null = null;

  /** Starts a new owner (a project became the one on screen). Returns its token; the previous owner is finished. */
  begin(project: RecordedProject): number {
    this.tokens += 1;
    this.owner = { token: this.tokens, project, stale: this.lastSeen, requested: null, wanted: null, armed: false, anchor: null, graceUntil: 0, missed: null, landing: false, protect: false };
    return this.tokens;
  }

  /** The project is no longer the one on screen. */
  end(token: number): void {
    if (this.owner?.token === token) this.owner = null;
  }

  /** The same owner, with a changed project (its linked ChatGPT Project got another address): arming and what was asked for stay. */
  retarget(token: number, project: RecordedProject): void {
    if (this.owner && this.owner.token === token) this.owner.project = project;
  }

  /** The owner asked the view to load `url`: nothing is recorded until the view has shown it (or the person has navigated since). */
  expect(token: number, url: string, opts: { restore?: boolean } = {}): void {
    const o = this.owner;
    if (!o || o.token !== token) return;
    o.requested = url;
    o.wanted = url;
    o.protect = opts.restore === true;
    o.armed = false;
    o.anchor = null;
    o.missed = null;
    o.landing = false;
    o.stale = this.lastSeen;
  }

  /** The view already shows what the owner wanted (or, with live views, a page of its own): what it reports from now on is the person's. */
  arm(token: number): void {
    const o = this.owner;
    if (o && o.token === token) { o.armed = true; o.requested = null; o.wanted = null; o.anchor = null; o.graceUntil = 0; o.missed = null; o.landing = false; }
  }

  /** The address ChatGPT showed instead of the one asked for, when it did (nothing was recorded for it); null otherwise. */
  missedPage(token: number): string | null {
    return this.owner && this.owner.token === token ? this.owner.missed : null;
  }

  /** A state of the view. Returns the address to remember for the owner, or null. */
  observe(state: Pick<ChatGptViewState, 'url' | 'status'>, now: number = Date.now()): { projectId: string; url: string } | null {
    const url = state.url;
    const o = this.owner;
    if (url !== null) this.lastSeen = url;
    if (!o || url === null) return null;
    if (!o.armed) {
      if (o.requested !== null && sameChatGptPage(url, o.requested)) {
        o.armed = true; o.requested = null; o.anchor = url; o.graceUntil = o.protect ? now + RESTORE_GRACE_MS : 0;
      } else if (url !== o.stale) {
        o.armed = true;
        if (o.requested !== null && o.protect) {
          // The request ended somewhere else: a redirect, a sign-in, a page that is gone. That page is not recorded and does not replace the
          // remembered one; what the person does from here on is recorded.
          o.requested = null; o.anchor = url; o.graceUntil = now + RESTORE_GRACE_MS; o.missed = url; o.landing = true;
          return null;
        }
        o.requested = null;
      } else return null;
    } else if (o.landing && o.wanted !== null && sameChatGptPage(url, o.wanted)) {
      o.anchor = url; o.graceUntil = 0; o.missed = null; o.landing = false; // arrived where it was asked to go after all (after signing in, say)
    } else if (o.protect && o.anchor !== null && now < o.graceUntil && !sameChatGptPage(url, o.anchor)) {
      // Moved off the restored page right after it loaded: ChatGPT's own redirect. The page it landed on is not recorded either.
      if (o.wanted !== null) { o.missed = url; o.landing = true; o.anchor = url; o.graceUntil = now + RESTORE_GRACE_MS; }
      return null;
    } else if (o.landing && o.anchor !== null && sameChatGptPage(url, o.anchor)) {
      return null; // still on the page ChatGPT sent the view to
    } else if (o.landing) {
      o.landing = false; o.anchor = null; // the person moved on from it
    }
    if (state.status !== 'ready') return null;
    const address = recordableAddress(url, o.project);
    return address === null ? null : { projectId: o.project.id, url: address };
  }
}
