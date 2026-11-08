/// App-wide state for Flow 2:
///
///   Open app -> login (username + password) -> OTP by email -> data
///   -> session ends 10 minutes after login -> back to login (new OTP needed)
library;

import 'package:flutter/foundation.dart';

import '../models/models.dart';
import 'api_client.dart';
import 'notifications.dart';
import 'session_store.dart';
import 'validation.dart';

enum AuthStage { loading, login, otp, home }

typedef ClientFactory = Future<ApiClient> Function(String serverUrl);

class AppController extends ChangeNotifier {
  AppController({
    required this.store,
    required this.notifier,
    ClientFactory? clientFactory,
  }) : _clientFactory = clientFactory ?? ApiClient.pinned;

  final SessionStore store;
  final AlertNotifier notifier;
  final ClientFactory _clientFactory;

  AuthStage stage = AuthStage.loading;
  String serverUrl = defaultServerUrl;

  /// Shown on the login screen (e.g. why the session ended).
  String? loginMessage;
  LoginChallenge? challenge;
  Session? session;
  ApiClient? api;

  void _go(AuthStage next) {
    stage = next;
    notifyListeners();
  }

  /// Restores a still-valid session from secure storage, otherwise shows login.
  Future<void> init() async {
    serverUrl = await store.readServerUrl() ?? defaultServerUrl;
    final saved = await store.readSession();
    if (saved == null || saved.isExpired()) {
      await store.clearSession();
      return _go(AuthStage.login);
    }
    try {
      final client = await _clientFactory(serverUrl);
      client.token = saved.token;
      await client.me(); // the server must still accept the token
      api = client;
      session = saved;
      _go(AuthStage.home);
    } on ApiException catch (e) {
      await store.clearSession();
      loginMessage = e.sessionEnded
          ? 'Your session ended - please log in again.'
          : null;
      _go(AuthStage.login);
    }
  }

  /// Step 1: username + password. Throws ApiException with a user-facing message.
  Future<void> login(String url, String username, String password) async {
    final urlError = validateServerUrl(url);
    if (urlError != null) throw ApiException(urlError);
    api?.close();
    final client = await _clientFactory(url);
    final c = await client.login(username.trim(), password);
    serverUrl = normalizeServerUrl(url).toString();
    await store.writeServerUrl(serverUrl);
    api = client;
    challenge = c;
    loginMessage = null;
    _go(AuthStage.otp);
  }

  /// Step 2: the emailed code. A wrong code invalidates the challenge -> login.
  Future<void> verifyOtp(String code) async {
    final client = api;
    final c = challenge;
    if (client == null || c == null) return backToLogin();
    try {
      final s = await client.verifyOtp(c.challengeId, code);
      client.token = s.token;
      await store.writeSession(s);
      session = s;
      challenge = null;
      notifier.reset();
      _go(AuthStage.home);
    } on ApiException catch (e) {
      if (e.restart || e.status == 401) return backToLogin(e.message);
      rethrow;
    }
  }

  void backToLogin([String? message]) {
    challenge = null;
    loginMessage = message;
    _go(AuthStage.login);
  }

  /// User pressed "Log out": delete the session on the server, then locally.
  Future<void> logout() async {
    try {
      await api?.logout();
    } on ApiException {
      // The session may already be gone - log out locally anyway.
    }
    await _endSession('You have been logged out.');
  }

  /// The countdown reached 0 or the server answered 401.
  Future<void> sessionEnded([String? reason]) => _endSession(
    reason ?? 'Session ended after 10 minutes. Log in again with a new code.',
  );

  Future<void> _endSession(String message) async {
    if (stage != AuthStage.home) return;
    await store.clearSession();
    api?.token = null;
    session = null;
    notifier.reset();
    loginMessage = message;
    _go(AuthStage.login);
  }
}
