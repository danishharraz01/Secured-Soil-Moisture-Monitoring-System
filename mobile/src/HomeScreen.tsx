import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert as RNAlert, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Alert, AuditEntry, Client, DeviceConfig, IntegrityResult, Reading, Session } from './api';
import { MoistureChart } from './MoistureChart';
import { notify } from './notifications';
import { colors } from './theme';

type Props = { session: Session; api: Client; onLogout: () => void };

const POLL_MS = 3000;
const LED_ON_MS = 60_000; // red LED stays on for a minute after motion
const SUSPICIOUS = /rejected|failed|blocked|forbidden|anomaly|otp_wrong|otp_locked|motion|idle/;
const ALERT_TITLE: Record<Alert['type'], string> = {
  sprinkler_on: 'Sprinkler turned on',
  motion: 'Motion detected',
  tamper: 'Tampering detected',
};

export function HomeScreen({ session, api, onLogout }: Props) {
  const isAdmin = session.role === 'admin';
  const [readings, setReadings] = useState<Reading[]>([]);
  const [waterMl, setWaterMl] = useState(0);
  const [config, setConfig] = useState<DeviceConfig | null>(null);
  const [lowText, setLowText] = useState('');
  const [highText, setHighText] = useState('');
  const [configMsg, setConfigMsg] = useState('');
  const [integrity, setIntegrity] = useState<IntegrityResult | null>(null);
  const [backupMsg, setBackupMsg] = useState('');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [lastMotionAt, setLastMotionAt] = useState<number | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const editing = useRef(false);
  const lastAlertId = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, cfg, al] = await Promise.all([api.readings(150), api.config(), api.alerts(lastAlertId.current ?? 0)]);
      setReadings(r.readings);
      setWaterMl(r.totals.water);
      const c = cfg[0] ?? null;
      setConfig(c);
      if (c && !editing.current) {
        setLowText(String(c.low));
        setHighText(String(c.high));
      }
      setLastMotionAt(al.lastMotionAt);
      if (al.alerts.length) {
        // First load just fills the list; after that every new alert also becomes a phone notification.
        if (lastAlertId.current !== null) for (const a of al.alerts) notify(ALERT_TITLE[a.type], a.message);
        lastAlertId.current = al.alerts[al.alerts.length - 1].id;
        setAlerts((prev) => [...al.alerts.slice().reverse(), ...prev].slice(0, 20));
      } else if (lastAlertId.current === null) {
        lastAlertId.current = 0;
      }
      if (isAdmin) setAudit(await api.audit());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, isAdmin]);

  // Poll while the app is open; stop when it goes to the background.
  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setInterval> | null = setInterval(refresh, POLL_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !timer) { refresh(); timer = setInterval(refresh, POLL_MS); }
      if (state !== 'active' && timer) { clearInterval(timer); timer = null; }
    });
    return () => { if (timer) clearInterval(timer); sub.remove(); };
  }, [refresh]);

  const last = readings[readings.length - 1];
  const gardenTime = last ? new Date(last.ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '–';
  const motionNow = lastMotionAt !== null && Date.now() - lastMotionAt < LED_ON_MS;

  async function saveThresholds() {
    setConfigMsg('');
    const low = Number(lowText);
    const high = Number(highText);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 10 || high > 95 || high - low < 5) {
      return setConfigMsg('Use 10–95%, with high at least 5% above low.');
    }
    if (!config) return;
    try {
      await api.setConfig(config.id, low, high);
      editing.current = false;
      setConfigMsg('Saved. The device picks this up on its next report.');
      refresh();
    } catch (e) {
      setConfigMsg((e as Error).message);
    }
  }

  async function runIntegrity() {
    try { setIntegrity(await api.verify()); } catch (e) { setError((e as Error).message); }
  }

  async function runBackup() {
    try {
      const r = await api.backup();
      setBackupMsg(`Saved ${r.records} readings to ${r.file} (encrypted).`);
    } catch (e) { setBackupMsg((e as Error).message); }
  }

  function confirmLogout() {
    RNAlert.alert('Log out?', 'You will need your password and an email code to log in again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: onLogout },
    ]);
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }} />}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Celery Soil Monitor</Text>
          <Text style={styles.muted}>{session.username} ({session.role}) · auto logout after 10 min idle</Text>
        </View>
        <Pressable onPress={confirmLogout} style={styles.ghost}><Text style={styles.ghostText}>Log out</Text></Pressable>
      </View>

      {error ? <Text style={styles.errorBox}>{error}</Text> : null}

      <View style={styles.statsRow}>
        <Stat label="Soil moisture" value={last ? `${last.moisture.toFixed(1)}%` : '–'} />
        <Stat label="Sprinkler" value={last ? (last.pump_on ? 'Watering' : 'Off') : '–'} color={last?.pump_on ? colors.green : undefined} />
      </View>
      <View style={styles.statsRow}>
        <View style={[styles.card, styles.stat]}>
          <Text style={styles.muted}>Motion sensor</Text>
          <View style={styles.ledRow}>
            <View style={[styles.led, motionNow && styles.ledOn]} />
            <Text style={[styles.statValue, motionNow && { color: colors.red }]}>{motionNow ? 'Motion!' : 'Clear'}</Text>
          </View>
        </View>
        <Stat label="Water used" value={`${(waterMl / 1000).toFixed(2)} L`} />
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Last {readings.length} readings</Text>
        <MoistureChart readings={readings} low={config?.low ?? 60} high={config?.high ?? 80} />
        <Text style={styles.hint}>Garden time {gardenTime}. Blue line is moisture, dashed lines are the thresholds, green bars show when the sprinkler ran.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Notifications</Text>
        {alerts.length === 0 ? <Text style={styles.hint}>Nothing yet.</Text> : null}
        {alerts.slice(0, 4).map((a) => (
          <View key={a.id} style={[styles.alert, a.level === 'warning' && styles.alertWarn, a.level === 'critical' && styles.alertCrit]}>
            <Text style={[styles.alertTitle, a.level === 'critical' && { color: colors.red }]}>{ALERT_TITLE[a.type]}</Text>
            <Text style={styles.alertBody}>{a.message}</Text>
            <Text style={styles.alertTime}>{new Date(a.at).toLocaleTimeString()}</Text>
          </View>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Watering thresholds</Text>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Start below (%)</Text>
            <TextInput style={styles.input} value={lowText} editable={isAdmin} keyboardType="number-pad"
              onFocus={() => (editing.current = true)} onChangeText={setLowText} />
          </View>
          <View style={{ width: 12 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Stop at (%)</Text>
            <TextInput style={styles.input} value={highText} editable={isAdmin} keyboardType="number-pad"
              onFocus={() => (editing.current = true)} onChangeText={setHighText} />
          </View>
        </View>
        {isAdmin ? (
          <Pressable style={styles.button} onPress={saveThresholds}><Text style={styles.buttonText}>Save</Text></Pressable>
        ) : (
          <Text style={styles.hint}>Read-only: only admin can change thresholds.</Text>
        )}
        {configMsg ? <Text style={styles.hint}>{configMsg}</Text> : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Data security</Text>
        <Text style={styles.hint}>Integrity check compares every stored reading against the signed hash chain.</Text>
        <Pressable style={[styles.button, { marginTop: 10 }]} onPress={runIntegrity}><Text style={styles.buttonText}>Run integrity check</Text></Pressable>
        {integrity ? (
          <Text style={[styles.result, { color: integrity.ok ? colors.green : colors.red }]}>
            {integrity.ok
              ? `OK: all ${integrity.checked} readings are intact.`
              : `Tampering detected${integrity.brokenAt ? ` at reading #${integrity.brokenAt}` : ''}: ${integrity.reason}`}
          </Text>
        ) : null}
        {isAdmin ? (
          <>
            <Text style={[styles.hint, { marginTop: 14 }]}>Cloud backup is encrypted with RSA-3072 + AES-256-GCM. It runs every 10 minutes.</Text>
            <Pressable style={[styles.buttonOutline, { marginTop: 10 }]} onPress={runBackup}><Text style={styles.buttonOutlineText}>Back up to cloud now</Text></Pressable>
            {backupMsg ? <Text style={styles.hint}>{backupMsg}</Text> : null}
          </>
        ) : null}
      </View>

      {isAdmin ? (
        <View style={styles.card}>
          <Text style={styles.h2}>Audit log</Text>
          {audit.slice(0, 25).map((a) => {
            const bad = SUSPICIOUS.test(a.action);
            return (
              <View key={a.id} style={styles.auditRow}>
                <Text style={[styles.auditAction, bad && { color: colors.red }]}>{a.action}</Text>
                <Text style={styles.auditMeta}>{new Date(a.at).toLocaleTimeString()} · {a.actor}{a.ip ? ` · ${a.ip}` : ''}</Text>
                {a.detail && a.detail !== 'null' ? <Text style={styles.auditDetail} numberOfLines={2}>{a.detail}</Text> : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </ScrollView>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={[styles.card, styles.stat]}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingTop: 56, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '600', color: colors.ink },
  muted: { color: colors.muted, fontSize: 13 },
  ghost: { borderWidth: 1, borderColor: '#cfd5c9', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  ghostText: { color: colors.ink },
  errorBox: { backgroundColor: colors.redSoft, color: colors.red, padding: 10, borderRadius: 8, marginBottom: 12 },
  statsRow: { flexDirection: 'row', gap: 12 },
  stat: { flex: 1 },
  statValue: { fontSize: 22, fontWeight: '600', color: colors.ink, marginTop: 2 },
  ledRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  led: { width: 14, height: 14, borderRadius: 7, backgroundColor: '#c9cfc4' },
  ledOn: { backgroundColor: '#d93a2b', borderWidth: 3, borderColor: 'rgba(217,58,43,0.25)' },
  card: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 12 },
  h2: { fontSize: 16, fontWeight: '600', color: colors.ink, marginBottom: 8 },
  hint: { color: colors.muted, fontSize: 13, marginTop: 8 },
  row: { flexDirection: 'row' },
  label: { fontSize: 13, color: colors.muted, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: '#cfd5c9', borderRadius: 8, padding: 10, fontSize: 16, color: colors.ink, marginBottom: 10 },
  button: { backgroundColor: colors.green, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  buttonOutline: { borderColor: colors.green, borderWidth: 1, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonOutlineText: { color: colors.green, fontSize: 15, fontWeight: '600' },
  result: { marginTop: 10, fontSize: 14 },
  alert: { backgroundColor: colors.bg, borderRadius: 8, padding: 10, marginBottom: 8 },
  alertWarn: { backgroundColor: '#fdf3e2' },
  alertCrit: { backgroundColor: colors.redSoft },
  alertTitle: { fontWeight: '600', color: colors.ink },
  alertBody: { color: colors.ink, fontSize: 13, marginTop: 2 },
  alertTime: { color: colors.muted, fontSize: 12, marginTop: 2 },
  auditRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#eef0eb' },
  auditAction: { fontWeight: '600', color: colors.ink },
  auditMeta: { color: colors.muted, fontSize: 12 },
  auditDetail: { color: colors.muted, fontSize: 12, fontFamily: 'monospace' },
});
