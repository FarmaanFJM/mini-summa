// Overlays: bottom sheet for secondary controls, confirm dialog, toast. A floating overlay may carry the single
// outline the guidance allows (--line-strong); everything inside it is borderless.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, space } from '../theme.ts';
import { Button } from './Button.tsx';
import type { ButtonVariant } from './Button.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { Text } from './Text.tsx';

export function Sheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.s4 }]}>
        <Text variant="heading" accessibilityRole="header" style={styles.sheetTitle}>{title}</Text>
        <ScrollView style={{ maxHeight: height * 0.65 }} contentContainerStyle={{ gap: space.s1 }}>{children}</ScrollView>
      </View>
    </Modal>
  );
}

export interface SheetOptionProps {
  label: string;
  onPress: () => void;
  selected?: boolean;
  icon?: IconName;
  hint?: string;
}

/** A row in a sheet. The selected option is a quiet fill, not an accent color. */
export function SheetOption({ label, onPress, selected, icon, hint }: SheetOptionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [styles.option, selected && { backgroundColor: colors.select }, pressed && { backgroundColor: colors.selectStrong }]}
    >
      {icon ? <Icon name={icon} size={20} color={colors.text} /> : null}
      <Text variant="body" style={{ flex: 1 }}>{label}</Text>
      {selected ? <Icon name="check" size={18} color={colors.text} /> : null}
    </Pressable>
  );
}

export interface ConfirmDialogProps {
  visible: boolean;
  /** A question with the verb and the object, never "Are you sure?". */
  title: string;
  /** One sentence of consequence. */
  body: string;
  confirmLabel: string;
  confirmVariant?: Extract<ButtonVariant, 'primary' | 'danger'>;
  cancelLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Cancel comes first and the confirm label repeats the verb of the title (Summa-UI confirm dialog preset). */
export function ConfirmDialog({ visible, title, body, confirmLabel, confirmVariant = 'primary', cancelLabel = 'Cancel', busy, error, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={styles.center}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <Text variant="body" accessibilityRole="header" style={{ fontSize: 18, lineHeight: 24, fontWeight: '600' }}>{title}</Text>
          <Text variant="body" tone="muted">{body}</Text>
          {error ? <Text variant="secondary" tone="danger" accessibilityRole="alert">{error}</Text> : null}
          <View style={styles.footer}>
            <Button label={cancelLabel} variant="secondary" onPress={onCancel} disabled={busy} />
            <Button label={confirmLabel} variant={confirmVariant} onPress={onConfirm} busy={busy} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---- toast ------------------------------------------------------------------------------------------------------

interface ToastApi { show(message: string, kind?: 'neutral' | 'success' | 'error'): void }
const ToastCtx = createContext<ToastApi>({ show: () => undefined });
export const useToast = (): ToastApi => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<{ id: number; message: string; kind: 'neutral' | 'success' | 'error' } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const counter = useRef(0);
  const show = useCallback((message: string, kind: 'neutral' | 'success' | 'error' = 'neutral') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ id: ++counter.current, message, kind });
    // Success and neutral go after 4s, errors stay until the next one (Summa-UI notification preset).
    if (kind !== 'error') timer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      {toast ? (
        <View pointerEvents="box-none" style={[styles.toastRegion, { bottom: insets.bottom + 88 }]}>
          <Pressable
            onPress={() => setToast(null)}
            accessibilityRole={toast.kind === 'error' ? 'alert' : 'text'}
            accessibilityLiveRegion="polite"
            accessibilityLabel={toast.message}
            style={styles.toast}
          >
            {toast.kind === 'success' ? <Icon name="circle-check" size={16} color={colors.accentText} /> : null}
            {toast.kind === 'error' ? <Icon name="circle-alert" size={16} color={colors.danger} /> : null}
            <Text variant="secondary" tone="default" style={{ flexShrink: 1 }}>{toast.message}</Text>
          </Pressable>
        </View>
      ) : null}
    </ToastCtx.Provider>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.backdrop },
  sheet: {
    backgroundColor: colors.s4, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: space.s4,
    paddingHorizontal: space.s4, gap: space.s2, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.lineStrong,
  },
  sheetTitle: { paddingHorizontal: space.s2, paddingBottom: space.s2 },
  option: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: space.s3, paddingHorizontal: space.s3, borderRadius: radius.md },
  center: { flex: 1, backgroundColor: colors.backdrop, justifyContent: 'center', padding: space.s5 },
  dialog: { backgroundColor: colors.s4, borderRadius: radius.xl, padding: space.s5, gap: space.s4, borderWidth: 1, borderColor: colors.lineStrong },
  footer: { gap: space.s2, marginTop: space.s2 },
  toastRegion: { position: 'absolute', left: space.s4, right: space.s4, alignItems: 'center' },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: space.s2, backgroundColor: colors.s4, borderRadius: radius.lg,
    paddingVertical: space.s3, paddingHorizontal: space.s4, maxWidth: 420, borderWidth: 1, borderColor: colors.lineStrong,
  },
});
