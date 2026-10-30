// A report in full. The body is fetched when the screen opens and lives in component state only: it is never written
// to disk (no storage module is imported here) and is gone when the screen closes.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Share, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { shortSessionId } from '@minisumma/shared';
import type { Report } from '@minisumma/shared';
import { useConnection, useConnectionApi } from '../connection/context.tsx';
import { declaredStatusText, deliveryText, envName, formatWhen } from '../lib/format.ts';
import { describeApiError } from '../lib/errors.ts';
import { toDisplayItems } from '../lib/fences.ts';
import type { DisplayItem } from '../lib/fences.ts';
import { openChatGpt } from '../lib/links.ts';
import { conversationForReport } from '../state/selectors.ts';
import { colors, radius, space } from '../theme.ts';
import { Button } from '../ui/Button.tsx';
import { EmptyState, GUTTER } from '../ui/layout.tsx';
import { ConnectionBanner } from '../ui/ConnectionBanner.tsx';
import { LoadingLine } from '../ui/LoadingLine.tsx';
import { Sheet, SheetOption, useToast } from '../ui/overlays.tsx';
import { ScreenTitle } from '../ui/ScreenTitle.tsx';
import { Text } from '../ui/Text.tsx';

type Load = { state: 'loading' } | { state: 'error'; message: string; missing: boolean } | { state: 'ready'; report: Report };

export function ReportDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useConnectionApi();
  const snap = useConnection();
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const report = await api.call('reports.get', { params: { id } });
      setLoad({ state: 'ready', report });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      setLoad({ state: 'error', message: describeApiError(err), missing: status === 404 });
    }
  }, [api, id]);

  useEffect(() => { void fetchReport(); }, [fetchReport]);

  const summary = snap.state.reports.find((r) => r.id === id);
  const report = load.state === 'ready' ? load.report : null;
  const items = useMemo(() => (report ? toDisplayItems(report.body) : []), [report]);
  const read = summary?.read ?? report?.read ?? false;
  const conversation = summary || report ? conversationForReport(snap.state, { id, projectId: (report ?? summary)!.projectId }) : null;

  const copy = async () => {
    if (!report) return;
    try {
      await Clipboard.setStringAsync(report.body);
      toast.show('Report copied', 'success');
    } catch { toast.show('Could not copy the report', 'error'); }
  };

  const share = async () => {
    setMenu(false);
    if (!report) return;
    try { await Share.share({ title: report.taskTitle, message: report.body }); } catch { setNote('Could not open the share sheet.'); }
  };

  const markRead = async () => {
    setMenu(false);
    try {
      const updated = await api.call('reports.markRead', { params: { id } });
      api.upsertReport(updated);
      setNote(null);
    } catch (err) { setNote(describeApiError(err)); }
  };

  const openConversation = async () => {
    if (!conversation) return;
    const r = await openChatGpt(conversation.url);
    setNote(r.ok ? null : r.message);
  };

  const head = summary ?? report;
  const Header = (
    <View style={styles.header}>
      {head ? (
        <>
          <Text variant="title" accessibilityRole="header">{head.taskTitle}</Text>
          <View style={{ gap: 2 }}>
            <Text variant="body">{head.projectName ?? 'No project'}, session {shortSessionId(head.sessionKey)} ({envName(head.env)})</Text>
            <Text variant="secondary">Captured {formatWhen(head.capturedAt)}</Text>
            <Text variant="secondary">{declaredStatusText[head.declaredStatus]}</Text>
            <Text variant="secondary">{deliveryText(head.delivery)}</Text>
          </View>
        </>
      ) : null}

      {report ? (
        <View style={{ gap: space.s2 }}>
          <Button label="Copy report" variant="primary" icon="copy" onPress={() => { void copy(); }} />
          {conversation ? (
            <>
              <Button label="Open linked ChatGPT conversation" icon="external" onPress={() => { void openConversation(); }} />
              <Text variant="caption">
                {conversation.source === 'delivery'
                  ? `Opens ${conversation.title}, the conversation chosen when this report arrived. Mini-Summa sends nothing to it.`
                  : `Opens ${conversation.title}, this project's preferred conversation. Mini-Summa sends nothing to it.`}
              </Text>
            </>
          ) : null}
          <View style={styles.more}>
            <Button label="More" variant="quiet" onPress={() => setMenu(true)} />
          </View>
        </View>
      ) : null}
      {note ? <Text variant="secondary" tone="danger" accessibilityRole="alert">{note}</Text> : null}
      {load.state === 'ready' ? <Text variant="heading">Full report</Text> : null}
    </View>
  );

  const renderItem = useCallback(({ item }: { item: DisplayItem }) => <BodyItem item={item} />, []);

  return (
    <View style={styles.page}>
      <ScreenTitle title="Report" />
      <ConnectionBanner />
      {load.state === 'loading' ? (
        <View style={styles.pad}>{Header}<LoadingLine text="Loading the full report" /></View>
      ) : load.state === 'error' ? (
        <View style={styles.pad}>
          {Header}
          <EmptyState
            text={load.missing ? 'This report is no longer on your PC.' : `Could not load the report. ${load.message}`}
            action={load.missing ? undefined : <Button label="Try again" onPress={() => { void fetchReport(); }} />}
          />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          ListHeaderComponent={Header}
          contentContainerStyle={styles.list}
          initialNumToRender={8}
          windowSize={9}
        />
      )}

      <Sheet visible={menu} title="Report options" onClose={() => setMenu(false)}>
        <SheetOption label="Share" icon="share" onPress={() => { void share(); }} />
        {!read ? <SheetOption label="Mark as read" icon="check" onPress={() => { void markRead(); }} /> : null}
      </Sheet>
    </View>
  );
}

function BodyItem({ item }: { item: DisplayItem }) {
  if (item.kind === 'code') {
    return (
      <View style={[styles.code, item.first && styles.codeFirst, item.last && styles.codeLast]}>
        <Text variant="code" selectable>{item.text}</Text>
      </View>
    );
  }
  return <Text variant="body" selectable style={styles.prose}>{item.text}</Text>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.s0 },
  pad: { paddingHorizontal: GUTTER, paddingTop: space.s3 },
  list: { paddingHorizontal: GUTTER, paddingBottom: space.s7 },
  header: { gap: space.s4, paddingTop: space.s3, paddingBottom: space.s4 },
  more: { alignItems: 'flex-start' },
  prose: { paddingVertical: 2 },
  code: { backgroundColor: colors.s2, paddingHorizontal: space.s4, paddingVertical: space.s2 },
  codeFirst: { borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, marginTop: space.s2, paddingTop: space.s3 },
  codeLast: { borderBottomLeftRadius: radius.md, borderBottomRightRadius: radius.md, marginBottom: space.s2, paddingBottom: space.s3 },
});

