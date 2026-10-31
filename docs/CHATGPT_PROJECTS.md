# Linking an existing ChatGPT Project

**Short answer.** OpenAI documents no way for a third party to list a person's ChatGPT Projects. Mini-Summa therefore does not discover them. A workspace is linked to an existing ChatGPT Project by **pasting the project's address**, which the person copies from their own signed-in ChatGPT. Mini-Summa stores that address, opens it in the embedded ChatGPT view, and does nothing else with it. **It does not import, read, mirror or sync anything from the project.**

**Method and date.** Researched on 2026-10-30 from OpenAI's developer documentation, with help-centre and policy pages read through search excerpts only. Several `help.openai.com` and `openai.com` pages answered HTTP 403 to the research tool, so the points marked *excerpt* are not verified page text and the terms of use were **not read in full**. Nobody has read OpenAI's terms for this work: the owner should read them (links below) before relying on the points about embedding. No private endpoint, no page scraping and no token or cookie handling was used. The real chatgpt.com cannot be reached from the test environment, so the linking flow is tested against a local stand-in (it proves what Mini-Summa does with an address, not what ChatGPT does).

## What was checked

| Question | Answer | Source |
| --- | --- | --- |
| Can an application list a user's Projects or chats through an API, a sign-in scope or an SDK? | **No, documented.** "Sign in with ChatGPT" identity scopes "don't grant access to ChatGPT conversations", and the programme is a limited trial for selected partners. Apps SDK plugins must not pull or reconstruct the chat log; the only handle is an anonymised conversation id | developers.openai.com/siwc/quickstart, developers.openai.com/plugins/plugin-guidelines |
| Is "projects" in the OpenAI API the same thing? | **No.** API projects are administrative containers inside a platform organisation (keys, members, limits). ChatGPT Projects group a signed-in user's chats, files and instructions. Mini-Summa uses neither the Admin API nor API keys | developers.openai.com/api/reference |
| Compliance Logs Platform | Enterprise or Edu administrators only; not for individual users | developers.openai.com/cookbook/examples/chatgpt/compliance_api |
| Data export | A manual export from Settings, emailed as a file (*excerpt*); what it says about Projects is not documented | help.openai.com article 7260999 |
| Documented address shapes for projects and chats | **Not documented.** The shapes seen in a browser (`/g/g-p-<id>-<name>/project`, `/c/<id>`) are observed only and may change. Documented are share links (`/share/...`) which are snapshots or invitations, not project references | help.openai.com articles 10169521 and 7925741 (*excerpt*) |
| Narrow window or embedded layout of chatgpt.com | **Not documented.** No official statement on minimum width, breakpoints or overlapping floating controls | developers.openai.com/plugins/concepts/ui-guidelines |
| Terms of use on embedding, automation, extraction | **Unread.** Reported (*excerpt*): no reverse engineering, no automated or programmatic extraction of data or output, no circumventing restrictions or protective measures. Embedding or framing chatgpt.com in an application is **not mentioned** in anything retrieved; that absence is unverified | openai.com/policies/row-terms-of-use, openai.com/policies/usage-policies |

## What Mini-Summa does

* **Link by address.** "Existing ChatGPT Project" in Add project, or the ChatGPT section of project settings, takes an address. Only `chatgpt.com` (and the legacy `chat.openai.com`) over https is accepted.
* **The query string and fragment are dropped.** A project address can carry an invitation token; an invitation is a credential, so Mini-Summa never keeps one. What is kept is host plus path.
* **An address of a form it does not recognise is kept as pasted** (without query and fragment), because ChatGPT does not document its addresses. For the form seen today (`/g/g-p-.../project`) the words in the address give the workspace a default title, and the address of a conversation inside a project is turned into the project's page. These readings are conveniences, not contracts.
* **Refused with a reason:** a single conversation outside any project, a custom GPT conversation, the home page, a share link, another site or another scheme.
* **Opening.** The linked project opens in the embedded ChatGPT view (or the person's browser in external mode). Mini-Summa never types, clicks, reads or scrapes in the page.
* **Conversations stay separate.** A ChatGPT conversation that should receive Claude's reports is still mapped explicitly ("Use this conversation for reports" when the project page shows one). The link to the project and the mapped conversations are independent.
* **Nothing is implied.** The interface says "linked", never "imported" or "synced".

## Persistent workspace: the last page used in each project

A Mini-Summa project is a persistent workspace, not a chat. You link your ChatGPT Project once and then open or create conversations with
ChatGPT's own screens; Mini-Summa has no conversation manager and **creating a conversation in ChatGPT never creates a Mini-Summa
project**. When you come back to a project it shows the last ChatGPT page you were on **in that project**, without pasting anything.

* **What is remembered.** The address of the last conversation or project page the embedded view showed while the project was
  selected, per project, in the core's window memory (`ui.perProject[id].chatgptUrl`, https chatgpt.com only, no query, no fragment,
  at most 600 characters). It is taken from the view's address, in-page navigation (what ChatGPT's own client does when you open a
  conversation) and full loads alike. The page itself is never read.
* **What is not.** The home page, settings, sign-in, share links, a page that is still loading or failed to load, and (when the project
  is linked to a ChatGPT Project whose address Mini-Summa recognises) any page that is not in that ChatGPT Project. A project linked by an
  address of a form Mini-Summa does not recognise, or not linked at all, remembers conversations only.
* **No mixing.** Right after you select another project the view may still show the previous project's page for a moment; nothing it
  reports then is recorded for the new project (the recorder only listens once the view has loaded the address the new project asked for,
  or you navigated). With live views each project has its own view anyway.
* **A visited conversation is never mapped.** Sending reports to a conversation stays the explicit action "Use this conversation for
  reports". Nothing you visit becomes a report destination, and nothing creates a project.
* **Opening a project** shows, in this order: the remembered last page, else the conversation you mapped (the one chosen last, else the
  preferred one), else the linked ChatGPT Project's page, else the empty state with the two ways to add one. The same on a restart.
  A project that was never linked keeps working as before.
* **Open project page** (the folder icon in the ChatGPT pane header, shown when a project is linked) opens the linked ChatGPT
  Project's page, the one place from which ChatGPT lists that project's own conversations.
* **Live views.** Each project keeps its own view while it is within the bound of 4, so the conversation, the scroll position and an
  unsent draft survive switching projects; an unloaded view is announced and loads again at its last address
  ([CHATGPT_PANE.md](CHATGPT_PANE.md)). **A draft does not survive an unload or a restart.**

**External limits, stated plainly.** "Last used" is **tracked locally by Mini-Summa**, on this computer, from the addresses the view
shows. The globally newest conversation of a ChatGPT Project, for example one started on your phone or another computer, **cannot be
discovered**: OpenAI documents no way to list a project's conversations or read their dates, and Mini-Summa uses no undocumented
interface, does not read or scrape the page, and does not read cookies or tokens. To get to a conversation you started elsewhere, use
Open project page and choose it in ChatGPT; Mini-Summa then remembers it. Verified on Linux against a local stand-in for chatgpt.com
only (X11); the real site's navigation was not observed and Windows is **NOT TESTED**.

## Not done, and why

* No project picker, no list of the person's projects, no search by name. No documented route exists; every route found needs an undocumented endpoint, page scraping or token capture.
* No reading of the page's title, content or links. The title shown is the one derived from the pasted address, or the one the person types.
* No import of the data export.

## For the owner

1. Read OpenAI's terms and usage policies (the two links above) and decide whether showing chatgpt.com in an embedded view is acceptable to you. The remedy that needs no one's permission exists: set ChatGPT to open in your browser (Settings, ChatGPT, external mode).
2. If OpenAI ever documents a conversations or projects scope for sign-in, or an official listing, revisit this page: discovery could then replace pasting.
