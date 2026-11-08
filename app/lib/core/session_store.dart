/// Persists the session token in flutter_secure_storage ONLY (Android Keystore
/// backed AES-GCM). The password is never stored anywhere.
library;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models/models.dart';

/// Abstract so tests can use an in-memory store.
abstract class SessionStore {
  Future<String?> readServerUrl();
  Future<void> writeServerUrl(String url);
  Future<Session?> readSession();
  Future<void> writeSession(Session session);
  Future<void> clearSession();
}

class SecureSessionStore implements SessionStore {
  SecureSessionStore([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  static const _kServerUrl = 'server_url';
  static const _kToken = 'session_token';
  static const _kExpiresAt = 'session_expires_at';
  static const _kUsername = 'session_username';
  static const _kRole = 'session_role';

  @override
  Future<String?> readServerUrl() => _storage.read(key: _kServerUrl);

  @override
  Future<void> writeServerUrl(String url) =>
      _storage.write(key: _kServerUrl, value: url);

  @override
  Future<Session?> readSession() async {
    final values = await Future.wait([
      _storage.read(key: _kToken),
      _storage.read(key: _kExpiresAt),
      _storage.read(key: _kUsername),
      _storage.read(key: _kRole),
    ]);
    if (values.any((v) => v == null)) return null;
    final expiresAt = DateTime.tryParse(values[1]!);
    if (expiresAt == null) return null;
    return Session(
      token: values[0]!,
      expiresAt: expiresAt.toLocal(),
      username: values[2]!,
      role: values[3]!,
    );
  }

  @override
  Future<void> writeSession(Session s) async {
    await _storage.write(key: _kToken, value: s.token);
    await _storage.write(
      key: _kExpiresAt,
      value: s.expiresAt.toUtc().toIso8601String(),
    );
    await _storage.write(key: _kUsername, value: s.username);
    await _storage.write(key: _kRole, value: s.role);
  }

  @override
  Future<void> clearSession() async {
    for (final key in [_kToken, _kExpiresAt, _kUsername, _kRole]) {
      await _storage.delete(key: key);
    }
  }
}

/// In-memory store for tests.
class MemorySessionStore implements SessionStore {
  String? serverUrl;
  Session? session;

  @override
  Future<String?> readServerUrl() async => serverUrl;
  @override
  Future<void> writeServerUrl(String url) async => serverUrl = url;
  @override
  Future<Session?> readSession() async => session;
  @override
  Future<void> writeSession(Session s) async => session = s;
  @override
  Future<void> clearSession() async => session = null;
}
