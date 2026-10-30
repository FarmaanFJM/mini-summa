// localStorage that never throws. It can be missing, blocked, full or cleared (private windows, previews), so every
// read and write is guarded and the UI must render correctly without it.
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createMemoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

export function safeLocalStorage(): KeyValueStorage {
  let area: Storage | null = null;
  try {
    area = typeof window !== 'undefined' ? window.localStorage : null;
    area?.getItem('minisumma.probe');
  } catch {
    area = null;
  }
  if (!area) return createMemoryStorage();
  const store = area;
  return {
    getItem: (k) => { try { return store.getItem(k); } catch { return null; } },
    setItem: (k, v) => { try { store.setItem(k, v); } catch { /* full or blocked: the value is simply not kept */ } },
    removeItem: (k) => { try { store.removeItem(k); } catch { /* nothing to do */ } },
  };
}

export function readJson<T>(storage: KeyValueStorage, key: string, validate: (value: unknown) => T | null): T | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    return validate(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeJson(storage: KeyValueStorage, key: string, value: unknown): void {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* unserialisable values are not kept */ }
}
