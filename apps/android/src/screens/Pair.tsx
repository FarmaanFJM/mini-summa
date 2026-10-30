// Pairing: scan the QR code shown on the PC, or type the address, offer ID and code. The decoded offer is shown and
// confirmed before anything is sent, then the screen walks the addresses in order and redeems the one-time code.
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ExpoLinking from 'expo-linking';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { decodePairingPayload } from '@minisumma/shared';
import type { PairingPayload } from '@minisumma/shared';
import { useSession } from '../app/SessionProvider.tsx';
import { PairingError, pairWithDesktop, payloadFromManualInput, suggestDeviceName } from '../pairing/pairing.ts';
import type { UrlAttempt } from '../pairing/pairing.ts';
import { colors, radius, space } from '../theme.ts';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { Fact, GUTTER, Group } from '../ui/layout.tsx';
import { Text } from '../ui/Text.tsx';

type Mode = 'scan' | 'manual';

const OUTCOME_TEXT: Record<UrlAttempt['outcome'], string> = {
  ok: 'answered',
  no_answer: 'no answer',
  timeout: 'timed out',
  tls: 'secure connection failed',
  cleartext: 'plain http is blocked',
  not_mini_summa: 'answered, but not Mini-Summa',
  http_error: 'answered with an error',
};

export function PairScreen() {
  const session = useSession();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>('scan');
  const [payload, setPayload] = useState<PairingPayload | null>(null);
  const [deviceName, setDeviceName] = useState(() => suggestDeviceName(Platform.OS === 'android' ? (Platform.constants as { Brand?: string; Model?: string } | undefined) : undefined));
  const [manual, setManual] = useState({ address: '', offerId: '', code: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairingError | string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();

  // A minisumma://pair link opened from outside the app (another app, NFC, a typed link) lands here too.
  const incoming = ExpoLinking.useURL();
  useEffect(() => {
    const decoded = incoming ? decodePairingPayload(incoming) : null;
    if (decoded) { setPayload(decoded); setError(null); }
  }, [incoming]);

  const onScanned = (data: string) => {
    if (payload || busy) return;
    const decoded = decodePairingPayload(data);
    if (decoded) { setPayload(decoded); setError(null); setScanNote(null); } else setScanNote('That QR code is not a Mini-Summa pairing code.');
  };

  const run = async (p: PairingPayload) => {
    setBusy(true);
    setError(null);
    try {
      const result = await pairWithDesktop(p, { deviceName });
      await session.completePairing(result.credentials);
    } catch (err) {
      setError(err instanceof PairingError ? err : 'Pairing failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const pairManual = () => {
    try { void run(payloadFromManualInput(manual)); } catch (err) { setError(err instanceof PairingError ? err : 'Check the details and try again.'); }
  };

  // Pasting a pairing link into any field fills the whole offer.
  const typed = (key: keyof typeof manual) => (text: string) => {
    const decoded = decodePairingPayload(text);
    if (decoded) { setPayload(decoded); setMode('scan'); return; }
    setManual((m) => ({ ...m, [key]: text }));
  };

  const errorMessage = error instanceof PairingError ? error.message : error;
  const attempts = error instanceof PairingError ? error.attempts : [];

  return (
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.s5, paddingBottom: insets.bottom + space.s6 }]} keyboardShouldPersistTaps="handled">
        <Text variant="title" accessibilityRole="header">Pair this phone</Text>

        {session.notice ? (
          <View style={styles.notice} accessibilityRole="alert" testID="pair-notice">
            <Text variant="body">{session.notice}</Text>
          </View>
        ) : null}

        {payload ? (
          <>
            <Text variant="body" tone="muted">Check that this is your PC, then pair.</Text>
            <Group>
              <Fact label="Desktop">{payload.name}</Fact>
              <Fact label="Address">{payload.urls[0]}{payload.urls.length > 1 ? `\n${payload.urls.length - 1} more to try if the first does not answer` : ''}</Fact>
            </Group>
            <Field label="Name of this phone" value={deviceName} onChangeText={setDeviceName} maxLength={80} />
            <View style={styles.stack}>
              <Button label={`Pair with ${payload.name}`} variant="primary" busy={busy} onPress={() => { void run(payload); }} />
              <Button label="Use a different code" variant="secondary" disabled={busy} onPress={() => { setPayload(null); setError(null); }} />
            </View>
          </>
        ) : mode === 'scan' ? (
          <>
            <Text variant="body" tone="muted">On your PC, create a pairing code in Mini-Summa. Then scan its QR code here.</Text>
            {permission?.granted ? (
              <View style={styles.camera}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={(r) => onScanned(r.data)}
                />
              </View>
            ) : (
              <View style={styles.stack}>
                <Text variant="body" tone="muted">
                  {permission && !permission.canAskAgain
                    ? 'Camera access is off for Mini-Summa. Turn it on in Android settings, or enter the code by hand.'
                    : 'Mini-Summa needs the camera only to read the QR code. You can also enter the code by hand.'}
                </Text>
                {permission && !permission.canAskAgain
                  ? <Button label="Open Android settings" onPress={() => { void Linking.openSettings(); }} />
                  : <Button label="Allow camera" variant="primary" onPress={() => { void requestPermission(); }} />}
              </View>
            )}
            {scanNote ? <Text variant="secondary" tone="warn" accessibilityRole="alert">{scanNote}</Text> : null}
            <Button label="Enter the code by hand" variant="quiet" onPress={() => { setMode('manual'); setError(null); }} />
          </>
        ) : (
          <>
            <Text variant="body" tone="muted">Enter what Mini-Summa shows on your PC. You can also paste the pairing link into any field.</Text>
            <Field label="Address of your PC" value={manual.address} onChangeText={typed('address')} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://my-pc.tail1234.ts.net" />
            <Field label="Offer ID" value={manual.offerId} onChangeText={typed('offerId')} autoCapitalize="none" autoCorrect={false} monospace />
            <Field label="Pairing code" value={manual.code} onChangeText={typed('code')} autoCapitalize="none" autoCorrect={false} monospace />
            <Field label="Name of this phone" value={deviceName} onChangeText={setDeviceName} maxLength={80} />
            <View style={styles.stack}>
              <Button label="Pair" variant="primary" busy={busy} onPress={pairManual} />
              <Button label="Scan the QR code instead" variant="quiet" disabled={busy} onPress={() => { setMode('scan'); setError(null); }} />
            </View>
          </>
        )}

        {errorMessage ? (
          <View style={styles.stack} accessibilityRole="alert" testID="pair-error">
            <Text variant="body" tone="danger">{errorMessage}</Text>
            {attempts.length ? (
              <>
                <Button label={showDetails ? 'Hide details' : 'Show details'} variant="quiet" onPress={() => setShowDetails((v) => !v)} />
                {showDetails ? attempts.map((a) => (
                  <Text key={a.url} variant="caption" selectable>{`${a.url}: ${OUTCOME_TEXT[a.outcome]}${a.status ? ` (${a.status})` : ''}`}</Text>
                )) : null}
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.s0 },
  content: { paddingHorizontal: GUTTER, gap: space.s5, flexGrow: 1 },
  stack: { gap: space.s2 },
  notice: { backgroundColor: colors.s3, borderRadius: radius.lg, padding: space.s4 },
  camera: { height: 300, borderRadius: radius.xl, overflow: 'hidden', backgroundColor: colors.s1 },
});
