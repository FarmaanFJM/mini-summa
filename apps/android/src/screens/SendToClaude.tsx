// Send text to a managed, live Claude session.
//   compose  -> confirm ("Send this text to GitManager, session a1b2c3d4?") -> result
// The request carries one idempotency key per attempt. A network failure keeps the key, so Retry cannot double-send; any
// answer from the desktop (including "failed") ends the attempt, and sending again is a new, deliberate request.
import { useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { shortSessionId } from '@minisumma/shared';
import type { PendingAction } from '@minisumma/shared';
import { describeAction, MAX_PROMPT_CHARS, nextAttempt, sendGuard, sendPrompt } from '../actions/send.ts';
import type { SendAttempt } from '../actions/send.ts';
import { useConnection, useConnectionApi } from '../connection/context.tsx';
import { availabilityLabel, envName, originLabel, sessionTarget, stateLabel } from '../lib/format.ts';
import { go, useNav } from '../nav.ts';
import { findSession } from '../state/selectors.ts';
import { colors, radius, space } from '../theme.ts';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { EmptyState, Fact, Group, Screen } from '../ui/layout.tsx';
import { ScreenTitle } from '../ui/ScreenTitle.tsx';
import { Text } from '../ui/Text.tsx';

type Step = 'compose' | 'confirm' | 'result';
type Problem =
  | { kind: 'unconfirmed'; message: string }
  | { kind: 'refused'; message: string }
  | null;

export function SendToClaudeScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const api = useConnectionApi();
  const snap = useConnection();
  const nav = useNav();
  const session = findSession(snap.state, key);

  const [step, setStep] = useState<Step>('compose');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [created, setCreated] = useState<PendingAction | null>(null);
  const attempt = useRef<SendAttempt | null>(null);
  const confirmedGeneration = useRef<number | null>(null);

  const guard = sendGuard(session, snap.scopes);
  // The action's status moves on the desktop; follow it through the live state, falling back to what the reply said.
  const live = created ? snap.state.actions.find((a) => a.id === created.id) ?? created : null;
  const outcome = useMemo(() => (live ? describeAction(live) : null), [live]);

  if (!session || !guard.allowed) {
    return (
      <Screen>
        <ScreenTitle title="Send to Claude" />
        {/* A direct link or an old screen can land here for a session that no longer qualifies. */}
        {!guard.allowed && live ? null : (
          <>
            <EmptyState text={guard.allowed ? 'This session is no longer listed on your PC.' : guard.reason} />
            {!guard.allowed && guard.offerRemoteControl && session ? (
              <Button label="Continue with Remote Control" onPress={() => nav.push(go.remoteControl(session.key))} />
            ) : null}
          </>
        )}
        {live && outcome ? <ResultView outcome={outcome} /> : null}
      </Screen>
    );
  }

  const short = shortSessionId(session.key);
  const target = sessionTarget(session);
  const tooLong = text.length > MAX_PROMPT_CHARS;
  const generationChanged = confirmedGeneration.current !== null && session.generation !== confirmedGeneration.current;

  const review = () => {
    confirmedGeneration.current = session.generation;
    setProblem(null);
    setStep('confirm');
  };

  const submit = async () => {
    if (sending) return;
    // One key per compose attempt. The same text, session and generation reuse it; any edit starts a new attempt.
    attempt.current = nextAttempt(attempt.current, { sessionKey: session.key, text, generation: confirmedGeneration.current ?? session.generation });
    setSending(true);
    setProblem(null);
    const result = await sendPrompt(api.call, attempt.current);
    setSending(false);
    if (result.kind === 'action') {
      api.upsertAction(result.action);
      setCreated(result.action);
      attempt.current = null; // the desktop answered: this attempt is over
      setStep('result');
    } else if (result.kind === 'refused') {
      setProblem({ kind: 'refused', message: result.message });
      attempt.current = null;
      setStep('result');
    } else {
      setProblem({ kind: 'unconfirmed', message: result.message });
      setStep('result'); // the attempt (and its key) is kept for an explicit Retry
    }
  };

  const editAgain = () => {
    setCreated(null);
    setProblem(null);
    attempt.current = null;
    setStep('compose');
  };

  return (
    <Screen scroll={false}>
      <ScreenTitle title="Send to Claude" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView contentContainerStyle={{ gap: space.s5, paddingBottom: space.s6 }} keyboardShouldPersistTaps="handled">
          {step === 'compose' ? (
            <>
              <Target session={session} />
              <Field
                label="Text to send"
                value={text}
                onChangeText={setText}
                multiline
                minHeight={160}
                autoCapitalize="sentences"
                maxLength={MAX_PROMPT_CHARS + 1}
              />
              {text.length > MAX_PROMPT_CHARS * 0.8 ? (
                <Text variant="caption" tone={tooLong ? 'danger' : 'faint'}>{text.length} of {MAX_PROMPT_CHARS} characters</Text>
              ) : null}
              <Button label="Review" variant="primary" disabled={!text.trim() || tooLong} onPress={review} />
            </>
          ) : null}

          {step === 'confirm' ? (
            <>
              <Text variant="title" accessibilityRole="header">{`Send this text to ${session.projectName ?? 'no project'}, session ${short}?`}</Text>
              <Text variant="body" tone="muted">Claude will receive exactly this text in that session. Your PC may ask you to approve it first.</Text>
              <TextBlock text={text} />
              {generationChanged ? (
                <Text variant="body" tone="warn" accessibilityRole="alert">
                  This session was restarted while you were reviewing (generation {confirmedGeneration.current} to {session.generation}). Review the target again before sending.
                </Text>
              ) : null}
              <View style={{ gap: space.s2 }}>
                <Button label="Back to edit" variant="secondary" onPress={() => setStep('compose')} disabled={sending} />
                {generationChanged ? <Button label="Review again" variant="secondary" onPress={review} /> : (
                  <Button label="Send to Claude" variant="primary" icon="send" busy={sending} onPress={() => { void submit(); }} />
                )}
              </View>
            </>
          ) : null}

          {step === 'result' ? (
            <>
              <Text variant="caption">{target}</Text>
              {problem?.kind === 'unconfirmed' ? (
                <>
                  <Text variant="title" accessibilityRole="header">Could not confirm it was sent</Text>
                  <Text variant="body">{problem.message}</Text>
                  <Text variant="body" tone="muted">The text may or may not have reached your PC. Retry sends the same request again, so it cannot be delivered twice.</Text>
                  <TextBlock text={text} />
                  <View style={{ gap: space.s2 }}>
                    <Button label="Retry" variant="primary" busy={sending} onPress={() => { void submit(); }} />
                    <Button label="Edit text" variant="secondary" onPress={editAgain} disabled={sending} accessibilityHint="Starts a new request. Check your PC first in case the first one arrived." />
                  </View>
                </>
              ) : null}
              {problem?.kind === 'refused' ? (
                <>
                  <Text variant="title" accessibilityRole="header">{`Could not send: ${problem.message}`}</Text>
                  <Text variant="body" tone="muted">Nothing was sent.</Text>
                  <Button label="Edit text" variant="secondary" onPress={editAgain} />
                </>
              ) : null}
              {!problem && live && outcome ? (
                <>
                  <ResultView outcome={outcome} />
                  <TextBlock text={live.text ?? text} />
                  <View style={{ gap: space.s2 }}>
                    {outcome.tone === 'error' ? <Button label="Edit and send again" variant="secondary" onPress={editAgain} /> : null}
                    <Button label="Done" variant={outcome.tone === 'error' ? 'quiet' : 'primary'} onPress={() => nav.back()} />
                  </View>
                </>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function ResultView({ outcome }: { outcome: ReturnType<typeof describeAction> }) {
  return (
    <View style={{ gap: space.s2 }} accessibilityLiveRegion="polite">
      <Text variant="title" accessibilityRole="header" tone={outcome.tone === 'error' ? 'danger' : 'default'}>{outcome.headline}</Text>
      {outcome.detail ? <Text variant="body" tone="muted">{outcome.detail}</Text> : null}
    </View>
  );
}

/** The exact text that will be typed, monospaced, so nothing is hidden or reflowed. */
function TextBlock({ text }: { text: string }) {
  return (
    <View style={{ backgroundColor: colors.s2, borderRadius: radius.md, padding: space.s4 }}>
      <Text variant="code" selectable testID="prompt-text">{text}</Text>
    </View>
  );
}

function Target({ session }: { session: NonNullable<ReturnType<typeof findSession>> }) {
  const rows: [string, string][] = [
    ['Project', session.projectName ?? 'No project'],
    ['Session', `${shortSessionId(session.key)}${session.name ? `, ${session.name}` : ''}`],
    ['Kind', `${originLabel[session.origin]}, ${availabilityLabel[session.availability].toLowerCase()}, ${envName(session.env)}`],
    ['State', stateLabel(session)],
    ['Generation', String(session.generation)],
  ];
  return (
    <View style={{ gap: space.s2 }}>
      <Text variant="heading">Sending to</Text>
      <Group>
        {rows.map(([label, value]) => <Fact key={label} label={label}>{value}</Fact>)}
      </Group>
    </View>
  );
}
