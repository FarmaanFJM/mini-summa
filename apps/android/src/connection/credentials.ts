// The only thing the app persists: where the desktop is and the bearer token for this phone. It lives in
// expo-secure-store (Android Keystore backed). Report text, activity and every other API response stay in memory.
import * as SecureStore from 'expo-secure-store';

export interface Credentials {
  baseUrl: string;
  token: string;
  deviceId: string;
  serverName: string;
}

export interface CredentialStore {
  load(): Promise<Credentials | null>;
  save(credentials: Credentials): Promise<void>;
  clear(): Promise<void>;
}

export const CREDENTIALS_KEY = 'minisumma.credentials.v1';

export function isCredentials(value: unknown): value is Credentials {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
  return text(v.baseUrl) && /^https?:\/\//i.test(v.baseUrl) && text(v.token) && text(v.deviceId) && typeof v.serverName === 'string';
}

export function createSecureCredentialStore(): CredentialStore {
  return {
    async load() {
      try {
        const raw = await SecureStore.getItemAsync(CREDENTIALS_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return isCredentials(parsed) ? parsed : null;
      } catch {
        // Unreadable or corrupt storage is treated as "not paired". The user can pair again.
        return null;
      }
    },
    async save(credentials) {
      await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(credentials));
    },
    async clear() {
      await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
    },
  };
}
