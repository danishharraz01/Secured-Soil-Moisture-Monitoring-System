/// Data models for the API responses. Every parser is defensive: a missing or
/// wrongly typed field throws a FormatException instead of crashing later.
library;

T _req<T>(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is T) return value;
  throw FormatException('Field "$key" is missing or has the wrong type');
}

double _num(Map<String, dynamic> json, String key) =>
    _req<num>(json, key).toDouble();

DateTime _date(Map<String, dynamic> json, String key) =>
    DateTime.parse(_req<String>(json, key)).toLocal();

DateTime? _dateOrNull(Map<String, dynamic> json, String key) {
  final v = json[key];
  return v is String ? DateTime.parse(v).toLocal() : null;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

class LoginChallenge {
  const LoginChallenge({
    required this.challengeId,
    required this.sentTo,
    required this.expiresIn,
  });
  final String challengeId;
  final String sentTo;
  final int expiresIn;

  factory LoginChallenge.fromJson(Map<String, dynamic> json) => LoginChallenge(
    challengeId: _req<String>(json, 'challengeId'),
    sentTo: _req<String>(json, 'sentTo'),
    expiresIn: _req<num>(json, 'expiresIn').toInt(),
  );
}

class Session {
  const Session({
    required this.token,
    required this.expiresAt,
    required this.username,
    required this.role,
  });
  final String token;
  final DateTime expiresAt;
  final String username;
  final String role;

  bool get isAdmin => role == 'admin';
  bool isExpired([DateTime? now]) => !expiresAt.isAfter(now ?? DateTime.now());

  factory Session.fromJson(Map<String, dynamic> json) {
    final user = _req<Map<String, dynamic>>(json, 'user');
    final token = _req<String>(json, 'token');
    if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(token)) {
      throw const FormatException('Malformed session token');
    }
    return Session(
      token: token,
      expiresAt: _date(json, 'expiresAt'),
      username: _req<String>(user, 'username'),
      role: _req<String>(user, 'role'),
    );
  }
}

// ---------------------------------------------------------------------------
// Readings and device status
// ---------------------------------------------------------------------------

class Reading {
  const Reading({
    required this.id,
    required this.ts,
    required this.moistureMm,
    required this.pumpOn,
    required this.waterMl,
    required this.anomaly,
  });
  final int id;

  /// Device time (simulated time in demo mode).
  final DateTime ts;
  final double moistureMm;
  final bool pumpOn;
  final int waterMl;
  final bool anomaly;

  factory Reading.fromJson(Map<String, dynamic> json) => Reading(
    id: _req<num>(json, 'id').toInt(),
    ts: _date(json, 'ts'),
    moistureMm: _num(json, 'moistureMm'),
    pumpOn: _req<bool>(json, 'pumpOn'),
    waterMl: _req<num>(json, 'waterMl').toInt(),
    anomaly: json['anomaly'] == true,
  );
}

class DeviceStatus {
  const DeviceStatus({
    required this.id,
    required this.online,
    required this.lastSeenAt,
    required this.low,
    required this.high,
    required this.moistureMm,
    required this.pumpOn,
    required this.waterTodayMl,
    required this.lastMotionAt,
  });
  final String id;
  final bool online;
  final DateTime? lastSeenAt;
  final double low;
  final double high;
  final double? moistureMm;
  final bool pumpOn;
  final int waterTodayMl;
  final DateTime? lastMotionAt;

  factory DeviceStatus.fromJson(Map<String, dynamic> json) {
    final latest = json['latest'];
    return DeviceStatus(
      id: _req<String>(json, 'id'),
      online: _req<bool>(json, 'online'),
      lastSeenAt: _dateOrNull(json, 'lastSeenAt'),
      low: _num(json, 'low'),
      high: _num(json, 'high'),
      moistureMm: latest is Map<String, dynamic>
          ? _num(latest, 'moistureMm')
          : null,
      pumpOn: latest is Map<String, dynamic> && latest['pumpOn'] == true,
      waterTodayMl: _req<num>(json, 'waterTodayMl').toInt(),
      lastMotionAt: _dateOrNull(json, 'lastMotionAt'),
    );
  }

  /// Motion LED is red for 60 s after the last motion event.
  bool motionActive(DateTime serverNow) =>
      lastMotionAt != null &&
      serverNow.difference(lastMotionAt!).inSeconds < 60;
}

class DevicesSnapshot {
  const DevicesSnapshot({required this.devices, required this.serverTime});
  final List<DeviceStatus> devices;

  /// Server clock - used for "motion in the last 60 s" so phone clock skew does not matter.
  final DateTime serverTime;

  factory DevicesSnapshot.fromJson(Map<String, dynamic> json) =>
      DevicesSnapshot(
        devices: _req<List<dynamic>>(
          json,
          'devices',
        ).map((d) => DeviceStatus.fromJson(d as Map<String, dynamic>)).toList(),
        serverTime: _date(json, 'serverTime'),
      );
}

// ---------------------------------------------------------------------------
// Alerts / activity
// ---------------------------------------------------------------------------

enum AlertKind { pumpOn, pumpOff, motion, offline, online, tamper, unknown }

AlertKind alertKindFrom(String type) => switch (type) {
  'pump_on' => AlertKind.pumpOn,
  'pump_off' => AlertKind.pumpOff,
  'motion' => AlertKind.motion,
  'offline' => AlertKind.offline,
  'online' => AlertKind.online,
  'tamper' => AlertKind.tamper,
  _ => AlertKind.unknown,
};

class AlertItem {
  const AlertItem({
    required this.id,
    required this.at,
    required this.kind,
    required this.level,
    required this.message,
  });
  final int id;
  final DateTime at;
  final AlertKind kind;

  /// info | warning | critical
  final String level;
  final String message;

  String get title => switch (kind) {
    AlertKind.pumpOn => 'Water pump ON',
    AlertKind.pumpOff => 'Water pump OFF',
    AlertKind.motion => 'Motion detected!',
    AlertKind.offline => 'Device disconnected',
    AlertKind.online => 'Device connected',
    AlertKind.tamper => 'Tampering detected',
    AlertKind.unknown => 'Notification',
  };

  factory AlertItem.fromJson(Map<String, dynamic> json) => AlertItem(
    id: _req<num>(json, 'id').toInt(),
    at: _date(json, 'at'),
    kind: alertKindFrom(_req<String>(json, 'type')),
    level: _req<String>(json, 'level'),
    message: _req<String>(json, 'message'),
  );
}

class AlertsPage {
  const AlertsPage({required this.alerts, required this.latestId});

  /// Newest first.
  final List<AlertItem> alerts;
  final int latestId;

  factory AlertsPage.fromJson(Map<String, dynamic> json) => AlertsPage(
    alerts: _req<List<dynamic>>(
      json,
      'alerts',
    ).map((a) => AlertItem.fromJson(a as Map<String, dynamic>)).toList(),
    latestId: _req<num>(json, 'latestId').toInt(),
  );
}

// ---------------------------------------------------------------------------
// Report, config, integrity, backup, audit
// ---------------------------------------------------------------------------

class DailyReport {
  const DailyReport({
    required this.date,
    required this.readings,
    required this.avgMoistureMm,
    required this.minMoistureMm,
    required this.maxMoistureMm,
    required this.waterings,
    required this.totalWaterMl,
    required this.motionCount,
    required this.offlineMinutes,
  });
  final String date;
  final int readings;
  final double? avgMoistureMm;
  final double? minMoistureMm;
  final double? maxMoistureMm;
  final int waterings;
  final int totalWaterMl;
  final int motionCount;
  final int offlineMinutes;

  static double? _optNum(Map<String, dynamic> j, String k) =>
      j[k] is num ? (j[k] as num).toDouble() : null;

  factory DailyReport.fromJson(Map<String, dynamic> json) => DailyReport(
    date: _req<String>(json, 'date'),
    readings: _req<num>(json, 'readings').toInt(),
    avgMoistureMm: _optNum(json, 'avgMoistureMm'),
    minMoistureMm: _optNum(json, 'minMoistureMm'),
    maxMoistureMm: _optNum(json, 'maxMoistureMm'),
    waterings: _req<num>(json, 'waterings').toInt(),
    totalWaterMl: _req<num>(json, 'totalWaterMl').toInt(),
    motionCount: _req<num>(json, 'motionCount').toInt(),
    offlineMinutes: _req<num>(json, 'offlineMinutes').toInt(),
  );
}

class ThresholdConfig {
  const ThresholdConfig({required this.low, required this.high});
  final double low;
  final double high;

  factory ThresholdConfig.fromJson(Map<String, dynamic> json) =>
      ThresholdConfig(low: _num(json, 'low'), high: _num(json, 'high'));
}

class VerifyResult {
  const VerifyResult({
    required this.ok,
    required this.count,
    this.brokenAt,
    this.reason,
  });
  final bool ok;
  final int count;
  final int? brokenAt;
  final String? reason;

  factory VerifyResult.fromJson(Map<String, dynamic> json) => VerifyResult(
    ok: _req<bool>(json, 'ok'),
    count: _req<num>(json, 'count').toInt(),
    brokenAt: (json['brokenAt'] as num?)?.toInt(),
    reason: json['reason'] as String?,
  );
}

class BackupInfo {
  const BackupInfo({
    required this.file,
    required this.readings,
    required this.bytes,
  });
  final String file;
  final int readings;
  final int bytes;

  factory BackupInfo.fromJson(Map<String, dynamic> json) => BackupInfo(
    file: _req<String>(json, 'file'),
    readings: _req<num>(json, 'readings').toInt(),
    bytes: _req<num>(json, 'bytes').toInt(),
  );
}

class AuditEntry {
  const AuditEntry({
    required this.id,
    required this.at,
    required this.actor,
    required this.action,
    required this.detail,
    required this.ip,
    required this.suspicious,
  });
  final int id;
  final DateTime at;
  final String actor;
  final String action;
  final String detail;
  final String? ip;
  final bool suspicious;

  factory AuditEntry.fromJson(Map<String, dynamic> json) => AuditEntry(
    id: _req<num>(json, 'id').toInt(),
    at: _date(json, 'at'),
    actor: _req<String>(json, 'actor'),
    action: _req<String>(json, 'action'),
    detail: _req<String>(json, 'detail'),
    ip: json['ip'] as String?,
    suspicious: json['suspicious'] == true,
  );
}
