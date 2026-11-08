/// Generates the README screenshots of every app screen.
///
///   flutter test test_screenshots --update-goldens
///
/// Not part of the normal test run (it lives outside test/): font rendering
/// differs between machines, so these images are documentation, not assertions.
/// The real app widgets run against a fake API with realistic data.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soil_monitor/core/api_client.dart';
import 'package:soil_monitor/core/app_controller.dart';
import 'package:soil_monitor/core/notifications.dart';
import 'package:soil_monitor/core/session_store.dart';
import 'package:soil_monitor/main.dart';
import 'package:soil_monitor/models/models.dart';

const _out = '../../docs/screenshots';

/// Loads Roboto + Material Icons from the Flutter SDK so text and icons render for real.
Future<void> _loadFonts() async {
  final root = Platform.environment['FLUTTER_ROOT'] ?? '';
  final dir = '$root/bin/cache/artifacts/material_fonts';
  Future<ByteData> font(String name) async =>
      ByteData.sublistView(await File('$dir/$name').readAsBytes());
  final roboto = FontLoader('Roboto')
    ..addFont(font('roboto-regular.ttf'))
    ..addFont(font('roboto-medium.ttf'))
    ..addFont(font('roboto-bold.ttf'));
  await roboto.load();
  await (FontLoader(
    'MaterialIcons',
  )..addFont(font('materialicons-regular.otf'))).load();
}

class _SilentNotifier implements AlertNotifier {
  @override
  Future<void> init() async {}
  @override
  Future<void> onAlerts(AlertsPage page) async {}
  @override
  void reset() {}
}

/// A realistic day: drying, one watering cycle, motion a few seconds ago.
Map<String, dynamic> _fakeResponse(http.Request req) {
  final now = DateTime.now().toUtc();
  final start = DateTime(now.year, now.month, now.day, 6).toUtc();
  String iso(DateTime d) => d.toUtc().toIso8601String();
  final rnd = Random(7);

  switch (req.url.path) {
    case '/api/login':
      return {
        'otpRequired': true,
        'challengeId': '2f9c1a5e-8b7d-4c2a-9e31-5d6f7a8b9c0d',
        'sentTo': 'a****@mailsac.com',
        'expiresIn': 300,
      };
    case '/api/login/otp':
      return {
        'token': 'a' * 64,
        'expiresAt': iso(
          DateTime.now().add(const Duration(minutes: 9, seconds: 41)),
        ),
        'user': {'username': 'admin', 'role': 'admin'},
      };
    case '/api/readings':
      var mm = 29.5;
      var pump = false;
      final readings = <Map<String, dynamic>>[];
      for (var i = 0; i < 120; i++) {
        final ts = start.add(Duration(minutes: 10 * i));
        final day = ts.toLocal().hour >= 9 && ts.toLocal().hour < 18;
        mm += pump
            ? 1.3 - 0.2
            : -((day ? 0.36 : 0.14) + rnd.nextDouble() * 0.12);
        if (!pump && mm <= 24.5) pump = true;
        if (pump && mm >= 32) pump = false;
        readings.add({
          'id': 400 + i,
          'deviceId': 'celery-node-01',
          'ts': iso(ts),
          'moistureMm': double.parse(mm.toStringAsFixed(2)),
          'pumpOn': pump,
          'waterMl': pump ? 45 : 0,
          'anomaly': false,
        });
      }
      return {'unit': 'mm', 'readings': readings};
    case '/api/devices':
      return {
        'devices': [
          {
            'id': 'celery-node-01',
            'online': true,
            'lastSeenAt': iso(now.subtract(const Duration(seconds: 4))),
            'low': 24.5,
            'high': 32,
            'latest': {
              'id': 519,
              'ts': iso(now),
              'moistureMm': 26.84,
              'pumpOn': false,
            },
            'waterTodayMl': 1260,
            'lastMotionAt': iso(now.subtract(const Duration(seconds: 12))),
          },
        ],
        'serverTime': iso(now),
      };
    case '/api/alerts':
    case '/api/activity':
      final items = [
        (
          9,
          'motion',
          'warning',
          'Motion detected near the celery bed (sensor pir-1) - red LED is on',
          12,
        ),
        (
          8,
          'pump_off',
          'info',
          'Soil moisture reached 32.2 mm, water pump switched off (used 405 ml)',
          70,
        ),
        (
          7,
          'pump_on',
          'info',
          'Soil moisture 24.4 mm (<= 24.5 mm), relay switched the water pump on',
          80,
        ),
        (6, 'online', 'info', 'Device celery-node-01 reconnected', 160),
        (5, 'offline', 'critical', 'Device celery-node-01 disconnected', 200),
        (
          4,
          'pump_off',
          'info',
          'Soil moisture reached 32.0 mm, water pump switched off (used 360 ml)',
          300,
        ),
        (
          3,
          'pump_on',
          'info',
          'Soil moisture 24.3 mm (<= 24.5 mm), relay switched the water pump on',
          309,
        ),
      ];
      final list = [
        for (final (id, type, level, message, secondsAgo) in items)
          {
            'id': id,
            'at': iso(now.subtract(Duration(seconds: secondsAgo))),
            'simTime': null,
            'type': type,
            'level': level,
            'message': message,
          },
      ];
      return req.url.path == '/api/alerts'
          ? {'alerts': list, 'latestId': 9}
          : {'events': list};
    case '/api/report':
      return {
        'date':
            '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}',
        'readings': 144,
        'avgMoistureMm': 28.1,
        'minMoistureMm': 24.2,
        'maxMoistureMm': 32.6,
        'waterings': 3,
        'totalWaterMl': 1260,
        'motionCount': 2,
        'offlineMinutes': 340,
      };
    case '/api/config':
      return {
        'deviceId': 'celery-node-01',
        'unit': 'mm',
        'low': 24.5,
        'high': 32,
        'limits': {'minLow': 5, 'maxHigh': 50, 'minGap': 2},
      };
    case '/api/verify':
      return {'ok': true, 'count': 519, 'lastId': 519};
    case '/api/backup':
      return {
        'file': 'backup-2026-11-08T11-02-10-114Z.json',
        'createdAt': iso(now),
        'readings': 519,
        'bytes': 226304,
      };
    case '/api/audit':
      final entries = [
        ('chain_verified', 'admin', '519 readings OK', false, 5),
        ('otp_wrong', 'viewer', 'wrong code - challenge invalidated', true, 95),
        (
          'forbidden',
          'viewer',
          'viewer tried PUT /api/config (requires admin)',
          true,
          130,
        ),
        ('login_success', 'admin', 'password + OTP ok', false, 140),
        ('login_failed', 'admin', 'wrong password', true, 160),
        (
          'device_rejected',
          'celery-node-01',
          'replay: Replay detected: nonce already used',
          true,
          400,
        ),
      ];
      return {
        'entries': [
          for (final (i, e) in entries.indexed)
            {
              'id': 60 - i,
              'at': iso(now.subtract(Duration(seconds: e.$5))),
              'actor': e.$2,
              'action': e.$1,
              'detail': e.$3,
              'ip': '192.168.0.23',
              'suspicious': e.$4,
            },
        ],
      };
  }
  return {'error': 'not found'};
}

Future<AppController> _app(
  WidgetTester tester, {
  Size size = const Size(412, 915),
}) async {
  tester.view.physicalSize = size * 2.5;
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);
  final mock = MockClient(
    (req) async => http.Response(
      jsonEncode(_fakeResponse(req)),
      200,
      headers: {'content-type': 'application/json'},
    ),
  );
  final controller = AppController(
    store: MemorySessionStore(),
    notifier: _SilentNotifier(),
    clientFactory: (url) async => ApiClient(Uri.parse(url), mock),
  );
  await tester.pumpWidget(SoilMonitorApp(controller: controller));
  await controller.init();
  await tester.pump();
  return controller;
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _shot(WidgetTester tester, String name) => expectLater(
  find.byType(SoilMonitorApp),
  matchesGoldenFile('$_out/app-$name.png'),
);

/// Disposes the home screen so its poll/countdown timers stop.
Future<void> _done(WidgetTester tester) => tester.pumpWidget(const SizedBox());

void main() {
  setUpAll(_loadFonts);

  testWidgets('login', (tester) async {
    final c = await _app(tester);
    // Same message the app shows when the 10-minute session runs out.
    c.backToLogin(
      'Session ended after 10 minutes. Log in again with a new code.',
    );
    await tester.pump();
    await tester.enterText(find.byKey(const Key('username')), 'admin');
    await tester.enterText(
      find.byKey(const Key('password')),
      'secret-password',
    );
    await _settle(tester);
    await _shot(tester, '1-login');
  });

  testWidgets('otp', (tester) async {
    final c = await _app(tester);
    await tester.runAsync(
      () => c.login('https://192.168.0.12:8443', 'admin', 'x'),
    );
    await _settle(tester);
    await tester.enterText(find.byKey(const Key('otp')), '4821');
    await _settle(tester);
    await _shot(tester, '2-otp');
  });

  Future<void> home(
    WidgetTester tester, {
    int tab = 0,
    Size size = const Size(412, 915),
  }) async {
    final c = await _app(tester, size: size);
    await tester.runAsync(() async {
      await c.login('https://192.168.0.12:8443', 'admin', 'x');
      await c.verifyOtp('482193');
    });
    await tester.pump();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 300)),
    );
    await _settle(tester);
    if (tab > 0) {
      await tester.tap(find.byType(NavigationDestination).at(tab));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 300)),
      );
      await _settle(tester);
    }
  }

  testWidgets('dashboard', (tester) async {
    await home(tester, size: const Size(412, 1540));
    await _shot(tester, '3-dashboard');
    await _done(tester);
  });

  testWidgets('activity', (tester) async {
    await home(tester, tab: 1);
    await _shot(tester, '4-activity');
    await _done(tester);
  });

  testWidgets('report', (tester) async {
    await home(tester, tab: 2);
    await _shot(tester, '5-report');
    await _done(tester);
  });

  testWidgets('settings', (tester) async {
    await home(tester, tab: 3, size: const Size(412, 1700));
    await tester.tap(find.text('Run integrity check'));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 200)),
    );
    await _settle(tester);
    await tester.tap(find.text('Back up to cloud now'));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 200)),
    );
    await _settle(tester);
    await _shot(tester, '6-settings');
    await _done(tester);
  });
}
