// Pending actions that need a decision: permission requests from managed Claude sessions and prompts sent from phones.
// The exact summary is shown (tool and redacted excerpt, or the full prompt text). Approve and Reject need the
// `approve` scope; without it the buttons are not offered and the card says why.
import { useState } from 'react';
import { View } from 'react-native';
import { shortSessionId } from '@minisumma/shared';
import type { PendingAction } from '@minisumma/shared';
import { canDecide } from '../actions/approvals.ts';
import { describeAction } from '../actions/send.ts';
import { useConnection, useConnectionApi } from '../connection/context.tsx';
import { describeApiError } from '../lib/errors.ts';
import { actionKindLabel, formatExpiry, formatWhen } from '../lib/format.ts';
import { go, useNav } from '../nav.ts';
import { pendingActions, recentActions } from '../state/selectors.ts';
import { colors, radius, space } from '../theme.ts';
import { Button } from '../ui/Button.tsx';
import { EmptyState, Group, Row, Screen, Section, TabHeader } from '../ui/layout.tsx';
import { LoadingLine } from '../ui/LoadingLine.tsx';
import { Text } from '../ui/Text.tsx';

export function InboxScreen() {
  const snap = useConnection();
  const api = useConnectionApi();
  const nav = useNav();
  const { state } = snap;
  const pending = pendingActions(state);
  const recent = recentActions(state);

  return (
    <Screen topInset onRefresh={() => api.refresh()}>
      <TabHeader title="Inbox" />
      {!state.loaded ? <LoadingLine /> : (
        <>
          {pending.length ? (
            <View style={{ gap: space.s4 }}>
              {pending.map((a) => <ActionCard key={a.id} action={a} />)}
            </View>
          ) : (
            <EmptyState text="No requests are waiting for you." />
          )}
          {recent.length ? (
            <Section title="Recent">
              <Group>
                {recent.map((a) => {
                  const outcome = describeAction(a);
                  return (
                    <Row
                      key={a.id}
                      title={`${actionKindLabel(a)}: ${a.projectName ?? 'No project'}, session ${shortSessionId(a.sessionKey)}`}
                      subtitle={outcome.headline}
                      meta={formatWhen(a.decidedAt ?? a.createdAt)}
                      onPress={() => nav.push(go.session(a.sessionKey))}
                    />
                  );
                })}
              </Group>
            </Section>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function who(a: PendingAction): string {
  if (a.createdBy.kind === 'device') return `Sent from ${a.createdBy.name}`;
  if (a.createdBy.kind === 'desktop') return 'Created on your PC';
  return 'Raised by Mini-Summa';
}

export function ActionCard({ action }: { action: PendingAction }) {
  const api = useConnectionApi();
  const snap = useConnection();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decision = canDecide(action, { scopes: snap.scopes, deviceId: snap.device?.id ?? null });
  const isPrompt = action.kind === 'claude_prompt';

  const decide = async (kind: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const updated = kind === 'approve'
        ? await api.call('actions.approve', { params: { id: action.id } })
        : await api.call('actions.reject', { params: { id: action.id }, body: {} });
      api.upsertAction(updated);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ backgroundColor: colors.s1, borderRadius: radius.lg, padding: space.s4, gap: space.s3 }} testID={`action-${action.id}`}>
      <View style={{ gap: 2 }}>
        <Text variant="heading">{actionKindLabel(action)}</Text>
        <Text variant="body">{`${action.projectName ?? 'No project'}, session ${shortSessionId(action.sessionKey)}`}</Text>
      </View>

      <View style={{ backgroundColor: colors.s2, borderRadius: radius.md, padding: space.s3 }}>
        <Text variant="code" selectable testID="action-summary">{isPrompt && action.text ? action.text : action.summary}</Text>
      </View>

      <Text variant="caption">{`${who(action)} · ${formatExpiry(action.expiresAt)}`}</Text>
      {action.target.problem ? <Text variant="secondary" tone="warn">{action.target.problem}</Text> : null}

      {decision.can ? (
        <View style={{ flexDirection: 'row', gap: space.s2 }}>
          <Button label="Reject" variant="secondary" style={{ flex: 1 }} disabled={busy !== null} busy={busy === 'reject'} onPress={() => { void decide('reject'); }} />
          <Button label="Approve" variant="primary" style={{ flex: 1 }} disabled={busy !== null} busy={busy === 'approve'} onPress={() => { void decide('approve'); }} />
        </View>
      ) : (
        <Text variant="secondary" testID="decision-blocked">{decision.reason}</Text>
      )}
      {error ? <Text variant="secondary" tone="danger" accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}
