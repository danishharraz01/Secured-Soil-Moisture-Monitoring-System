import 'package:flutter_test/flutter_test.dart';
import 'package:soil_monitor/core/countdown.dart';
import 'package:soil_monitor/core/notifications.dart';
import 'package:soil_monitor/core/validation.dart';
import 'package:soil_monitor/models/models.dart';
import 'package:soil_monitor/widgets/moisture_chart.dart';

void main() {
  group('server URL validation', () {
    test('accepts https URLs with host and optional port', () {
      expect(validateServerUrl('https://localhost:8443'), isNull);
      expect(validateServerUrl('https://10.0.2.2:8443/'), isNull);
      expect(validateServerUrl('  https://soil.example.com  '), isNull);
      expect(validateServerUrl('HTTPS://LOCALHOST:8443'), isNull);
    });

    test('rejects plain HTTP and anything that is not https', () {
      for (final url in [
        'http://localhost:8443',
        'localhost:8443',
        'ftp://x',
        'ws://x',
      ]) {
        expect(
          validateServerUrl(url),
          'Server URL must start with https://',
          reason: url,
        );
      }
    });

    test('rejects empty, credentials, paths, queries and fragments', () {
      expect(validateServerUrl(''), 'Enter the server URL');
      expect(validateServerUrl(null), 'Enter the server URL');
      expect(validateServerUrl('https://'), isNotNull);
      expect(
        validateServerUrl('https://user:pw@localhost:8443'),
        contains('credentials'),
      );
      expect(validateServerUrl('https://localhost:8443/api'), isNotNull);
      expect(validateServerUrl('https://localhost:8443?x=1'), isNotNull);
      expect(validateServerUrl('https://localhost:8443#x'), isNotNull);
    });

    test('normalizes host case and trailing slash', () {
      expect(
        normalizeServerUrl('https://LocalHost:8443/').toString(),
        'https://localhost:8443',
      );
      expect(
        normalizeServerUrl('https://example.com').toString(),
        'https://example.com',
      );
    });
  });

  group('threshold validation (same rule as the server)', () {
    test('accepts valid pairs', () {
      expect(validThresholds(24.5, 32), isTrue);
      expect(validThresholds(5, 7), isTrue);
      expect(validThresholds(48, 50), isTrue);
      expect(
        validThresholds(28.1, 30.1),
        isTrue,
      ); // floating point gap 1.9999999
    });

    test('rejects invalid pairs with a reason', () {
      expect(validThresholds(4.9, 32), isFalse);
      expect(validThresholds(24.5, 50.1), isFalse);
      expect(validThresholds(30, 31.5), isFalse);
      expect(validThresholds(double.nan, 32), isFalse);
      expect(thresholdError(4, 32), contains('at least 5'));
      expect(thresholdError(10, 51), contains('at most 50'));
      expect(thresholdError(30, 31), contains('2 mm'));
      expect(thresholdError(null, 32), contains('both'));
      expect(thresholdError(24.5, 32), isNull);
    });
  });

  test('OTP format is exactly 6 digits', () {
    expect(isOtpCode('012345'), isTrue);
    expect(isOtpCode('12345'), isFalse);
    expect(isOtpCode('1234567'), isFalse);
    expect(isOtpCode('12a456'), isFalse);
  });

  group('countdown', () {
    final expires = DateTime(2026, 11, 8, 10, 10);

    test('formats mm:ss and never goes negative', () {
      expect(formatCountdown(const Duration(minutes: 10)), '10:00');
      expect(formatCountdown(const Duration(minutes: 9, seconds: 41)), '09:41');
      expect(
        formatCountdown(const Duration(milliseconds: 200)),
        '00:01',
      ); // rounds up
      expect(formatCountdown(Duration.zero), '00:00');
      expect(
        remaining(expires, now: DateTime(2026, 11, 8, 10, 11)),
        Duration.zero,
      );
      expect(
        remaining(expires, now: DateTime(2026, 11, 8, 10, 0)),
        const Duration(minutes: 10),
      );
    });

    test('time ago', () {
      final now = DateTime(2026, 11, 8, 12);
      expect(
        timeAgo(now.subtract(const Duration(seconds: 2)), now: now),
        'just now',
      );
      expect(
        timeAgo(now.subtract(const Duration(seconds: 45)), now: now),
        '45 s ago',
      );
      expect(
        timeAgo(now.subtract(const Duration(minutes: 3)), now: now),
        '3 min ago',
      );
      expect(
        timeAgo(now.subtract(const Duration(hours: 2)), now: now),
        '2 h ago',
      );
    });
  });

  group('model parsing', () {
    test('session', () {
      final s = Session.fromJson({
        'token': 'ab' * 32,
        'expiresAt': '2026-11-08T10:10:00.000Z',
        'user': {'username': 'admin', 'role': 'admin'},
      });
      expect(s.isAdmin, isTrue);
      expect(s.expiresAt.isUtc, isFalse); // converted to local time
      expect(s.isExpired(DateTime.utc(2026, 11, 8, 10, 10)), isTrue);
      expect(s.isExpired(DateTime.utc(2026, 11, 8, 10, 9)), isFalse);
    });

    test('rejects a malformed token or missing fields', () {
      expect(
        () => Session.fromJson({
          'token': 'short',
          'expiresAt': '2026-11-08T10:10:00Z',
          'user': {'username': 'a', 'role': 'admin'},
        }),
        throwsFormatException,
      );
      expect(() => Reading.fromJson({'id': 1}), throwsFormatException);
      expect(
        () => LoginChallenge.fromJson({'challengeId': 5}),
        throwsFormatException,
      );
    });

    test('devices snapshot and motion LED (60 s, server clock)', () {
      final snap = DevicesSnapshot.fromJson({
        'serverTime': '2026-11-08T10:00:00.000Z',
        'devices': [
          {
            'id': 'celery-node-01',
            'online': true,
            'lastSeenAt': '2026-11-08T09:59:55.000Z',
            'low': 24.5,
            'high': 32,
            'latest': {
              'id': 9,
              'ts': '2026-11-08T16:00:00.000Z',
              'moistureMm': 27.3,
              'pumpOn': true,
            },
            'waterTodayMl': 90,
            'lastMotionAt': '2026-11-08T09:59:10.000Z',
          },
        ],
      });
      final d = snap.devices.single;
      expect(d.moistureMm, 27.3);
      expect(d.pumpOn, isTrue);
      expect(d.high, 32.0);
      expect(d.motionActive(snap.serverTime), isTrue); // 50 s ago
      expect(
        d.motionActive(snap.serverTime.add(const Duration(seconds: 15))),
        isFalse,
      );
    });

    test('alerts, report, verify, audit', () {
      final page = AlertsPage.fromJson({
        'latestId': 3,
        'alerts': [
          {
            'id': 3,
            'at': '2026-11-08T10:00:00Z',
            'type': 'tamper',
            'level': 'critical',
            'message': 'x',
          },
          {
            'id': 2,
            'at': '2026-11-08T09:00:00Z',
            'type': 'pump_on',
            'level': 'info',
            'message': 'y',
          },
        ],
      });
      expect(page.alerts.map((a) => a.kind), [
        AlertKind.tamper,
        AlertKind.pumpOn,
      ]);
      expect(page.alerts.first.title, 'Tampering detected');

      final r = DailyReport.fromJson({
        'date': '2026-11-08',
        'readings': 0,
        'avgMoistureMm': null,
        'minMoistureMm': null,
        'maxMoistureMm': null,
        'waterings': 0,
        'totalWaterMl': 0,
        'motionCount': 0,
        'offlineMinutes': 0,
      });
      expect(r.avgMoistureMm, isNull);

      final v = VerifyResult.fromJson({
        'ok': false,
        'count': 4,
        'brokenAt': 2,
        'reason': 'Reading #2 was modified',
      });
      expect((v.ok, v.brokenAt), (false, 2));

      final a = AuditEntry.fromJson({
        'id': 1,
        'at': '2026-11-08T10:00:00Z',
        'actor': 'viewer',
        'action': 'forbidden',
        'detail': 'd',
        'ip': null,
        'suspicious': true,
      });
      expect(a.suspicious, isTrue);
    });
  });

  group('new alert notifications', () {
    AlertsPage page(List<int> ids) => AlertsPage(
      latestId: ids.isEmpty ? 0 : ids.first,
      alerts: [
        for (final id in ids)
          AlertItem(
            id: id,
            at: DateTime(2026),
            kind: AlertKind.motion,
            level: 'warning',
            message: '#$id',
          ),
      ],
    );

    test('first load announces nothing, later polls announce only new alerts (oldest first)', () {
      final t = NewAlertTracker();
      expect(t.take(page([5, 4, 3])), isEmpty);
      expect(t.take(page([5, 4, 3])), isEmpty);
      expect(t.take(page([8, 7, 6, 5])).map((a) => a.id), [6, 7, 8]);
      t.reset();
      expect(t.take(page([9, 8])), isEmpty); // after logout: fresh start
    });
  });

  test('chart shading: pump-on index ranges', () {
    Reading r(int i, bool on) => Reading(
      id: i,
      ts: DateTime(2026),
      moistureMm: 25,
      pumpOn: on,
      waterMl: 0,
      anomaly: false,
    );
    final readings = [
      for (final (i, on) in [
        false,
        true,
        true,
        false,
        true,
        false,
        false,
        true,
      ].indexed)
        r(i, on),
    ];
    expect(pumpOnRanges(readings), [(1, 2), (4, 4), (7, 7)]);
    expect(pumpOnRanges([]), isEmpty);
  });
}
