// Phone notifications for "water pump turned on", "motion detected" and "tampering".
// These are local notifications raised by the app when it sees a new alert, which work in
// Expo Go. Remote push (alerts while the app is fully closed) needs a development build and
// Expo push / FCM; see README.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

let ready = false;

export async function setupNotifications() {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('alerts', {
        name: 'Plant alerts',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
    ready = granted;
  } catch {
    ready = false; // e.g. web or a simulator without notification support
  }
}

export async function notify(title: string, body: string) {
  if (!ready) return;
  try {
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
  } catch {
    // ignore: a failed notification must never break the app
  }
}
