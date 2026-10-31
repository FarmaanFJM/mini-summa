import type { LinkTarget } from '@minisumma/shared';
import { useCallback } from 'react';
import { useRuntime } from '../../app/runtime';

/**
 * Goes where a link of an activity entry points: a project, a session, a report, a handoff, a conversation, a pending
 * request or a settings section. Looks things up when it is called, so it never acts on a stale copy of the store.
 */
export function useOpenLink(): (link: LinkTarget) => void {
  const { route, store } = useRuntime();
  return useCallback((link) => {
    const go = route.getState();
    const state = store.getState();
    switch (link.kind) {
      case 'project': go.go({ view: 'workspace', projectId: link.id }); return;
      case 'session': go.go({ view: 'workspace', sessionKey: link.key, projectId: state.sessions.find((s) => s.key === link.key)?.projectId ?? undefined }); return;
      case 'report': go.go({ view: 'reports', reportId: link.id }); return;
      case 'delivery': go.go({ view: 'reports', deliveryId: link.id, reportId: state.deliveries.find((d) => d.id === link.id)?.reportId }); return;
      case 'conversation': {
        const conversation = state.conversations.find((c) => c.id === link.id);
        if (!conversation) return;
        go.selectConversation(conversation.projectId, conversation.id);
        go.go({ view: 'workspace', projectId: conversation.projectId });
        return;
      }
      case 'action': go.go({ view: 'activity', section: 'needs-you' }); return;
      case 'settings': go.go({ view: 'settings', section: link.section }); return;
    }
  }, [route, store]);
}
