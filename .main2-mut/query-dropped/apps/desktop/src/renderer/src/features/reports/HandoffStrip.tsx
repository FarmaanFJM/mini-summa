// The handoff strip: a compact band above the two panes of the workspace while a report of the selected project waits for the
// person. It exists so that the whole loop can be done without leaving the workspace: "Copy and open" opens the mapped conversation
// in the pane right below, and after the person has pasted and sent the message there, "I sent it" is in the same place.
//
// It uses the same actions and the same plan as the handoff card (useHandoffActions, model.ts). It never says a message was sent
// before the person says so; copying and opening are not delivery. It is part of the page, not floating, so the native ChatGPT view
// is laid out below it by the same bounds logic as everything else.
//
// Showing it changes nothing: unlike the card, which prepares the message when the person opens a report, the strip appears by
// itself (when a report arrives, or when the app starts), and a restart must never touch a delivery (acceptance check A23). So it
// does not prepare the message to learn how many parts it has. A long message is learned when it is first copied ("Part 1 of 3 is
// on your clipboard", and the main button then names part 2); one that was prepared before names its parts from the start.
import './shared.css';
import './handoffStrip.css';
import type { Project } from '@minisumma/shared';
import { useMemo } from 'react';
import { useApp, useRoute } from '../../app/runtime';
import { Button, Icon } from '../../ui';
import { describeStrip } from './handoffStrip';
import type { StripView } from './handoffStrip';
import { useProjectConversations } from './hooks';
import type { HandoffActionId, HandoffButton } from './model';
import { useHandoffActions } from './useHandoffActions';

/** What the strip shows for a project, or null when nothing waits. The workspace also asks, to keep its own main action quiet meanwhile. */
export function useHandoffStrip(projectId: string): StripView | null {
  const deliveries = useApp((s) => s.deliveries);
  const conversations = useProjectConversations(projectId);
  return useMemo(() => describeStrip(deliveries, projectId, conversations.length), [deliveries, projectId, conversations.length]);
}

export function HandoffStrip({ project }: { project: Pick<Project, 'id' | 'name'> }) {
  const view = useHandoffStrip(project.id);
  return view ? <StripBody view={view} /> : null;
}

const busyKey = (id: HandoffActionId): string => (id === 'copyAgain' ? 'copy' : id === 'markUncertain' ? 'uncertain' : id);

function StripBody({ view }: { view: StripView }) {
  const route = useRoute();
  const { delivery } = view;
  const actions = useHandoffActions(delivery);
  const { runner, copied, opened, failure } = actions;
  const busy = runner.busy;

  const press = (button: HandoffButton): void => {
    switch (button.id) {
      case 'handoff': void actions.handoff(button.part); break;
      case 'confirmSent': void actions.confirmSent(); break;
      case 'copyAgain': void actions.copyPart(); break;
      case 'open': void actions.openConversation(); break;
      case 'markUncertain': void actions.markUncertain(); break;
      default: break;
    }
  };
  const render = (button: HandoffButton, variant: 'primary' | 'secondary' | 'ghost') => (
    <Button
      key={`${button.id}-${button.label}`}
      size="sm"
      variant={variant}
      loading={busy === busyKey(button.id)}
      disabled={busy !== null && busy !== busyKey(button.id)}
      onClick={() => press(button)}
    >
      {button.label}
    </Button>
  );

  // Say what happened, but only what needs saying: that the text is on the clipboard, and anything that went wrong or looks off.
  const notes = [copied?.text, opened && opened.tone !== 'ok' ? opened.text : null].filter((t): t is string => Boolean(t));
  const tone = opened?.tone === 'error' ? 'error' : opened?.tone === 'warning' ? 'warning' : 'ok';

  return (
    <section className="ms-strip" aria-label={`Report handoff: ${delivery.taskTitle}`} data-waiting={view.waiting || undefined}>
      <Icon name={view.waiting ? 'clipboard' : 'file-text'} size={16} />
      <div className="ms-strip__text">
        <p className="ms-strip__headline" title={view.headline}>{view.headline}</p>
        <p className="ms-strip__detail" title={view.detail}>{view.detail}</p>
        {notes.length > 0 && !failure ? <p className="ms-strip__result" data-tone={tone} role="status">{notes.join(' ')}</p> : null}
        {failure ? (
          <div className="ms-strip__result" data-tone="error" role="alert">
            <p>Mini-Summa could not put the text on your clipboard ({failure.reason}). The handoff is recorded as copied, but your clipboard does not have it. Select the text below and copy it yourself, or press Copy again.</p>
            {failure.text ? <textarea className="sm-input ms-textarea ms-mono ms-strip__fallback" readOnly rows={3} aria-label="Text to copy by hand" value={failure.text} onFocus={(e) => e.currentTarget.select()} /> : null}
          </div>
        ) : null}
        {runner.error ? <p className="ms-strip__result" data-tone="error" role="alert">{runner.error}</p> : null}
      </div>
      <div className="ms-strip__actions">
        {view.primary ? render(view.primary, 'primary') : null}
        {view.secondary.map((b) => render(b, 'secondary'))}
        {view.quiet.map((b) => render(b, 'ghost'))}
        <button type="button" className="ms-x-linkbtn" onClick={() => route.go({ view: 'reports', reportId: delivery.reportId, deliveryId: delivery.id })}>Open report</button>
        {view.more > 0 ? (
          <button type="button" className="ms-x-linkbtn" aria-label={`+${view.more} more. Open the Reports queue`} onClick={() => route.go({ view: 'reports', reportId: undefined, deliveryId: undefined })}>
            +{view.more} more
          </button>
        ) : null}
      </div>
    </section>
  );
}
