// The session token is kept in the phone's secure storage (iOS Keychain /
// Android Keystore-backed), never in plain AsyncStorage where other code or a
// backup could read it.
import * as SecureStore from 'expo-secure-store';
import type { Session } from './api';

const KEY = 'celery_session';
const LAST_URL_KEY = 'celery_last_server_url';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY, // not synced to iCloud, not readable while locked
};

export async function saveSession(s: Session) {
  await SecureStore.setItemAsync(KEY, JSON.stringify(s), OPTIONS);
  await SecureStore.setItemAsync(LAST_URL_KEY, s.serverUrl, OPTIONS);
}

export async function loadSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    return s && typeof s.token === 'string' ? s : null;
  } catch {
    return null;
  }
}

export async function clearSession() {
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
}

export async function lastServerUrl(): Promise<string> {
  return (await SecureStore.getItemAsync(LAST_URL_KEY, OPTIONS)) || '';
}
