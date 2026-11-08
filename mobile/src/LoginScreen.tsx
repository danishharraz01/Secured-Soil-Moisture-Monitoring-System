import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, startLogin, verifyOtp, type OtpChallenge, type Session } from './api';
import { lastServerUrl } from './session';
import { colors } from './theme';

type Props = { onLoggedIn: (s: Session) => void; notice?: string };

export function LoginScreen({ onLoggedIn, notice }: Props) {
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    lastServerUrl().then((u) => u && setServerUrl(u));
  }, []);

  async function submitPassword() {
    setError('');
    if (!serverUrl || !username || !password) return setError('Fill in all three fields.');
    setBusy(true);
    try {
      setChallenge(await startLogin(serverUrl, username.trim(), password));
      setPassword(''); // don't keep the password in memory
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    setError('');
    if (!challenge) return;
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code from the email.');
    setBusy(true);
    try {
      onLoggedIn(await verifyOtp(challenge, code));
    } catch (e) {
      setCode('');
      // "Correct OTP? No" after too many tries -> back to the login step
      if (e instanceof ApiError && e.restart) setChallenge(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.title}>Celery Soil Monitor</Text>
        {notice && !challenge ? <Text style={styles.notice}>{notice}</Text> : null}

        {!challenge ? (
          <>
            <Text style={styles.step}>Step 1 of 2 · Sign in</Text>
            <Text style={styles.label}>Server URL</Text>
            <TextInput style={styles.input} value={serverUrl} onChangeText={setServerUrl} placeholder="https://192.168.0.10:8443"
              autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            <Text style={styles.label}>Username</Text>
            <TextInput style={styles.input} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} textContentType="username" />
            <Text style={styles.label}>Password</Text>
            <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none"
              autoCorrect={false} textContentType="password" onSubmitEditing={submitPassword} />
            <Pressable style={[styles.button, busy && styles.buttonBusy]} onPress={submitPassword} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Continue</Text>}
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.step}>Step 2 of 2 · Check your email</Text>
            <Text style={styles.body}>We sent a 6-digit code to {challenge.sentTo}. It expires in 5 minutes.</Text>
            <TextInput style={[styles.input, styles.code]} value={code} onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} placeholder="000000"
              onSubmitEditing={submitCode} />
            <Pressable style={[styles.button, busy && styles.buttonBusy]} onPress={submitCode} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Verify</Text>}
            </Pressable>
            <Pressable style={styles.link} onPress={() => { setChallenge(null); setCode(''); setError(''); }}>
              <Text style={styles.linkText}>Back</Text>
            </Pressable>
          </>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: colors.bg },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 20, borderWidth: 1, borderColor: colors.border },
  title: { fontSize: 22, fontWeight: '600', color: colors.ink, marginBottom: 4 },
  step: { color: colors.muted, fontSize: 13, marginBottom: 16 },
  body: { color: colors.ink, fontSize: 15, marginBottom: 12, lineHeight: 21 },
  notice: { backgroundColor: colors.redSoft, color: colors.red, padding: 10, borderRadius: 8, marginBottom: 12, marginTop: 8 },
  label: { fontSize: 13, color: colors.muted, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: '#cfd5c9', borderRadius: 8, padding: 10, marginBottom: 12, fontSize: 16, color: colors.ink },
  code: { fontSize: 28, letterSpacing: 10, textAlign: 'center', fontVariant: ['tabular-nums'] },
  button: { backgroundColor: colors.green, borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 4 },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { alignItems: 'center', padding: 10, marginTop: 4 },
  linkText: { color: colors.muted, fontSize: 15 },
  error: { color: colors.red, marginTop: 12 },
});
