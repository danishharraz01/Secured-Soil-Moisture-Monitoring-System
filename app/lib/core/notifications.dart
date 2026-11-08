/// Local notifications for NEW alerts (Android channel "Plant alerts").
///
/// The first poll after login only records the newest alert ID - older
/// alerts are not re-announced. Every later poll notifies about alerts with
/// a higher ID.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../models/models.dart';

/// Abstract so widget tests can count notifications without a platform.
abstract class AlertNotifier {
  Future<void> init();

  /// Called with each fresh alerts page (newest first).
  Future<void> onAlerts(AlertsPage page);

  /// Forget the last seen ID (on logout).
  void reset();
}

/// Decides which alerts are new. Pure logic - unit tested.
class NewAlertTracker {
  int? _lastSeenId;

  /// Returns the alerts to announce, oldest first.
  List<AlertItem> take(AlertsPage page) {
    final last = _lastSeenId;
    _lastSeenId = page.latestId;
    if (last == null) return const []; // first load: nothing is "new"
    return page.alerts.where((a) => a.id > last).toList().reversed.toList();
  }

  void reset() => _lastSeenId = null;
}

class LocalAlertNotifier implements AlertNotifier {
  final _plugin = FlutterLocalNotificationsPlugin();
  final _tracker = NewAlertTracker();
  bool _ready = false;

  static const _channel = AndroidNotificationChannel(
    'plant_alerts',
    'Plant alerts',
    description: 'Watering, motion, disconnection and tampering alerts',
    importance: Importance.high,
  );

  @override
  Future<void> init() async {
    try {
      await _plugin.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        ),
      );
      final android = _plugin
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >();
      await android?.createNotificationChannel(_channel);
      // Android 13+ asks the user for POST_NOTIFICATIONS.
      await android?.requestNotificationsPermission();
      _ready = true;
    } catch (e) {
      // Notifications are a convenience - the app keeps working without them.
      debugPrint('Notifications unavailable: $e');
    }
  }

  @override
  Future<void> onAlerts(AlertsPage page) async {
    final fresh = _tracker.take(page);
    if (!_ready) return;
    // At most 5 at once, so a burst cannot flood the notification shade.
    for (final alert in fresh.take(5)) {
      await _plugin.show(
        id: alert.id,
        title: alert.title,
        body: alert.message,
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            _channel.id,
            _channel.name,
            channelDescription: _channel.description,
            importance: Importance.high,
            priority: alert.level == 'info'
                ? Priority.defaultPriority
                : Priority.high,
          ),
        ),
      );
    }
  }

  @override
  void reset() => _tracker.reset();
}
