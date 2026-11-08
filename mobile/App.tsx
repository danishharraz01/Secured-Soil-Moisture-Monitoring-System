import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { client, type Session } from './src/api';
import { clearSession, loadSession, saveSession } from './src/session';
import { setupNotifications } from './src/notifications';
import { HomeScreen } from './src/HomeScreen';
import { LoginScreen } from './src/LoginScreen';
import { colors } from './src/theme';

// "Log out after 10 minutes": if nobody touches the app for 10 minutes (or it sits in the
// background that long), the session is ended. The server enforces the same limit.
const IDLE_MS = 10 * 60_000;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    setupNotifications();
    loadSession().then((s) => { setSession(s); setLoading(false); });
  }, []);

  const signOut = useCallback(async (message = '') => {
    await clearSession();
    setSession(null);
    setNotice(message);
  }, []);

  const api = useMemo(
    () => (session ? client(session, (msg) => signOut(msg || 'Your session ended. Please log in again.')) : null),
    [session, signOut]
  );

  const idleLogout = useCallback(() => {
    if (!api) return;
    api.logout().catch(() => {});
    signOut('Logged out after 10 minutes of inactivity.');
  }, [api, signOut]);

  // Idle timer while open + check when coming back from the background.
  useEffect(() => {
    if (!session) return;
    lastActivity.current = Date.now();
    const t = setInterval(() => { if (Date.now() - lastActivity.current > IDLE_MS) idleLogout(); }, 15_000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastActivity.current > IDLE_MS) idleLogout();
    });
    return () => { clearInterval(t); sub.remove(); };
  }, [session, idleLogout]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }} onTouchStart={() => { lastActivity.current = Date.now(); }}>
      <StatusBar style="dark" />
      {session && api ? (
        <HomeScreen
          session={session}
          api={api}
          onLogout={async () => {
            await api.logout().catch(() => {}); // revoke on the server too, not just delete locally
            signOut();
          }}
        />
      ) : (
        <LoginScreen
          notice={notice}
          onLoggedIn={async (s) => { await saveSession(s); setNotice(''); setSession(s); }}
        />
      )}
    </View>
  );
}
