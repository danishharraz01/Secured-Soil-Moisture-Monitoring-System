/// Widget tests of Flow 2 with a fake API: login -> OTP -> dashboard,
/// wrong OTP -> back to login, session countdown -> back to login.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soil_monitor/core/api_client.dart';
import 'package:soil_monitor/core/app_controller.dart';
import 'package:soil_monitor/core/notifications.dart';
import 'package:soil_monitor/core/session_store.dart';
import 'package:soil_monitor/main.dart';
import 'package:soil_monitor/models/models.dart';

class _CountingNotifier implements AlertNotifier {
  int pages = 0;
  @override
  Future<void> init() async {}
  @override
  Future<void> onAlerts(AlertsPage page) async => pages++;
  @override
  void reset() {}
}

/// Minimal fake server. [sessionSeconds] controls the session length.
MockClient fakeServer({
  int sessionSeconds = 600,
  void Function(http.Request)? onRequest,
}) {
  return MockClient((req) async {
    onRequest?.call(req);
    final now = DateTime.now().toUtc();
    http.Response json(Object body, [int status = 200]) => http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json'},
    );
    switch (req.url.path) {
      case '/api/login':
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        return body['password'] == 'right'
            ? json({
                'otpRequired': true,
                'challengeId': 'c1',
                'sentTo': 'a****@mailsac.com',
                'expiresIn': 300,
              })
            : json({'error': 'Wrong username or password'}, 401);
      case '/api/login/otp':
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        if (body['code'] != '123456') {
          return json({
            'error': 'Wrong code - please log in again',
            'restart': true,
          }, 401);
        }
        return json({
          'token': 'f' * 64,
          'expiresAt': now
              .add(Duration(seconds: sessionSeconds))
              .toIso8601String(),
          'user': {'username': 'viewer', 'role': 'viewer'},
        });
      case '/api/devices':
        return json({
          'serverTime': now.toIso8601String(),
          'devices': [
            {
              'id': 'celery-node-01',
              'online': false,
              'lastSeenAt': now
                  .subtract(const Duration(minutes: 2))
                  .toIso8601String(),
              'low': 24.5,
              'high': 32,
              'latest': {
                'id': 1,
                'ts': now.toIso8601String(),
                'moistureMm': 27.3,
                'pumpOn': true,
              },
              'waterTodayMl': 135,
              'lastMotionAt': null,
            },
          ],
        });
      case '/api/readings':
        return json({'unit': 'mm', 'readings': []});
      case '/api/alerts':
        return json({'alerts': [], 'latestId': 0});
    }
    return json({'error': 'Not found'}, 404);
  });
}

Future<AppController> pumpApp(WidgetTester tester, MockClient client) async {
  final controller = AppController(
    store: MemorySessionStore(),
    notifier: _CountingNotifier(),
    clientFactory: (url) async => ApiClient(Uri.parse(url), client),
  );
  await tester.pumpWidget(SoilMonitorApp(controller: controller));
  await controller.init();
  await tester.pump();
  return controller;
}

Future<void> enterLogin(
  WidgetTester tester, {
  String url = 'https://localhost:8443',
  String password = 'right',
}) async {
  await tester.enterText(find.byKey(const Key('serverUrl')), url);
  await tester.enterText(find.byKey(const Key('username')), 'viewer');
  await tester.enterText(find.byKey(const Key('password')), password);
  await tester.tap(find.byKey(const Key('continue')));
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('rejects a plain http:// server URL before sending anything', (
    tester,
  ) async {
    var requests = 0;
    await pumpApp(tester, fakeServer(onRequest: (_) => requests++));
    await enterLogin(tester, url: 'http://localhost:8443');
    expect(find.text('Server URL must start with https://'), findsOneWidget);
    expect(requests, 0);
  });

  testWidgets(
    'wrong password shows the generic error and clears the password',
    (tester) async {
      await pumpApp(tester, fakeServer());
      await enterLogin(tester, password: 'wrong');
      expect(find.text('Wrong username or password'), findsOneWidget);
      final field = tester.widget<TextFormField>(
        find.byKey(const Key('password')),
      );
      expect(field.controller!.text, isEmpty);
    },
  );

  testWidgets('password -> OTP -> dashboard (viewer, device offline banner)', (
    tester,
  ) async {
    final c = await pumpApp(tester, fakeServer());
    await enterLogin(tester);
    expect(
      find.text('We sent a 6-digit code to a****@mailsac.com'),
      findsOneWidget,
    );

    await tester.enterText(find.byKey(const Key('otp')), '123456');
    await tester.tap(find.byKey(const Key('verify')));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(c.stage, AuthStage.home);
    expect(find.textContaining('viewer · Viewer'), findsOneWidget);
    expect(find.textContaining('Session ends in'), findsOneWidget);
    expect(find.text('27.3 mm'), findsOneWidget);
    expect(find.text('Watering'), findsOneWidget);
    expect(find.textContaining('Device disconnected'), findsOneWidget);
    expect(
      (await c.store.readSession())?.token,
      'f' * 64,
    ); // token kept in the (secure) store

    await tester.pumpWidget(const SizedBox()); // stop the poll/countdown timers
  });

  testWidgets('a wrong OTP sends the user back to login with the reason', (
    tester,
  ) async {
    final c = await pumpApp(tester, fakeServer());
    await enterLogin(tester);
    await tester.enterText(find.byKey(const Key('otp')), '000000');
    await tester.tap(find.byKey(const Key('verify')));
    await tester.pump();
    await tester.pump();
    expect(c.stage, AuthStage.login);
    expect(find.text('Wrong code - please log in again'), findsOneWidget);
    expect(c.challenge, isNull);
  });

  testWidgets(
    'the session countdown reaching 00:00 logs out and explains why',
    (tester) async {
      final c = await pumpApp(tester, fakeServer(sessionSeconds: 1));
      await enterLogin(tester);
      await tester.enterText(find.byKey(const Key('otp')), '123456');
      await tester.tap(find.byKey(const Key('verify')));
      await tester.pump();
      await tester.pump();
      expect(c.stage, AuthStage.home);

      // Let real time pass the 1-second session, then fire the 1 s countdown timer.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1200)),
      );
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(c.stage, AuthStage.login);
      expect(
        find.textContaining('Session ended after 10 minutes'),
        findsOneWidget,
      );
      expect(await c.store.readSession(), isNull); // token deleted
    },
  );
}
