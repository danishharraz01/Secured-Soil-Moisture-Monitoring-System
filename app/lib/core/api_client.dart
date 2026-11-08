/// HTTPS client for the Soil Monitor API with the server certificate PINNED.
///
///  - SecurityContext(withTrustedRoots: false): the phone's CA store is NOT
///    used; only assets/server.crt is trusted. A man-in-the-middle with any
///    other certificate - even one from a real CA - is refused.
///  - badCertificateCallback always returns false: bad certificates are never
///    accepted, not even "just for testing".
///  - every request times out after 10 s.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart' show rootBundle;
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

import '../models/models.dart';
import 'validation.dart';

const requestTimeout = Duration(seconds: 10);

/// An API or network error with a message that can be shown to the user.
class ApiException implements Exception {
  const ApiException(
    this.message, {
    this.status,
    this.reason,
    this.restart = false,
  });

  final String message;

  /// HTTP status, or null for network/TLS problems.
  final int? status;

  /// Why a 401 happened: missing | invalid | expired.
  final String? reason;

  /// OTP failed: the flowchart goes back to the login screen.
  final bool restart;

  /// The session is gone (expired / invalid) - the app must log in again.
  bool get sessionEnded => status == 401 && !restart;

  @override
  String toString() => message;
}

class ApiClient {
  ApiClient(this.baseUri, this._http);

  /// Builds a client that trusts ONLY the bundled server certificate.
  static Future<ApiClient> pinned(String serverUrl) async {
    final error = validateServerUrl(serverUrl);
    if (error != null) throw ApiException(error);
    final cert = await rootBundle.load('assets/server.crt');
    final context = SecurityContext(withTrustedRoots: false)
      ..setTrustedCertificatesBytes(cert.buffer.asUint8List());
    final httpClient = HttpClient(context: context)
      ..connectionTimeout = requestTimeout
      ..badCertificateCallback = (cert, host, port) => false;
    return ApiClient(normalizeServerUrl(serverUrl), IOClient(httpClient));
  }

  final Uri baseUri;
  final http.Client _http;

  /// Bearer token of the current session (never written anywhere but secure storage).
  String? token;

  void close() => _http.close();

  // -------------------------------------------------------------------------
  // Low level
  // -------------------------------------------------------------------------

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, String>? query,
    Object? body,
  }) async {
    final uri = baseUri.replace(path: path, queryParameters: query);
    final request = http.Request(method, uri)
      ..headers['Accept'] = 'application/json';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    if (token != null) request.headers['Authorization'] = 'Bearer $token';

    final http.Response response;
    try {
      response = await http.Response.fromStream(
        await _http.send(request).timeout(requestTimeout),
      ).timeout(requestTimeout);
    } on TimeoutException {
      throw const ApiException('The server did not answer within 10 seconds');
    } on HandshakeException {
      throw const ApiException(
        'Server certificate is not trusted (it does not match the pinned certificate)',
      );
    } on TlsException {
      throw const ApiException('Secure connection failed');
    } on SocketException {
      throw ApiException(
        'Cannot reach the server at ${baseUri.host}:${baseUri.port}',
      );
    } on http.ClientException catch (e) {
      throw ApiException('Network error: ${e.message}');
    }

    Map<String, dynamic> json = const {};
    if (response.body.isNotEmpty) {
      try {
        final decoded = jsonDecode(response.body);
        if (decoded is Map<String, dynamic>) json = decoded;
      } on FormatException {
        throw ApiException(
          'Unexpected reply from the server (HTTP ${response.statusCode})',
          status: response.statusCode,
        );
      }
    }
    if (response.statusCode >= 400) {
      throw ApiException(
        (json['error'] as String?) ??
            'Request failed (HTTP ${response.statusCode})',
        status: response.statusCode,
        reason: json['reason'] as String?,
        restart: json['restart'] == true,
      );
    }
    return json;
  }

  // -------------------------------------------------------------------------
  // Flow 2: login -> OTP -> session
  // -------------------------------------------------------------------------

  Future<LoginChallenge> login(String username, String password) async =>
      LoginChallenge.fromJson(
        await _send(
          'POST',
          '/api/login',
          body: {'username': username, 'password': password},
        ),
      );

  Future<Session> verifyOtp(String challengeId, String code) async =>
      Session.fromJson(
        await _send(
          'POST',
          '/api/login/otp',
          body: {'challengeId': challengeId, 'code': code},
        ),
      );

  Future<void> logout() => _send('POST', '/api/logout');

  Future<void> me() => _send('GET', '/api/me');

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  Future<DevicesSnapshot> devices() async =>
      DevicesSnapshot.fromJson(await _send('GET', '/api/devices'));

  Future<List<Reading>> readings({int limit = 150}) async {
    final json = await _send(
      'GET',
      '/api/readings',
      query: {'limit': '$limit'},
    );
    return (json['readings'] as List<dynamic>)
        .map((r) => Reading.fromJson(r as Map<String, dynamic>))
        .toList();
  }

  Future<AlertsPage> alerts() async =>
      AlertsPage.fromJson(await _send('GET', '/api/alerts'));

  Future<List<AlertItem>> activity({String? type, int limit = 100}) async {
    final json = await _send(
      'GET',
      '/api/activity',
      query: {'limit': '$limit', 'type': ?type},
    );
    return (json['events'] as List<dynamic>)
        .map((e) => AlertItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<DailyReport> report({String? date}) async => DailyReport.fromJson(
    await _send(
      'GET',
      '/api/report',
      query: date == null ? null : {'date': date},
    ),
  );

  Future<ThresholdConfig> config() async =>
      ThresholdConfig.fromJson(await _send('GET', '/api/config'));

  Future<ThresholdConfig> updateConfig(double low, double high) async =>
      ThresholdConfig.fromJson(
        await _send('PUT', '/api/config', body: {'low': low, 'high': high}),
      );

  Future<VerifyResult> verify() async =>
      VerifyResult.fromJson(await _send('GET', '/api/verify'));

  Future<BackupInfo> backup() async =>
      BackupInfo.fromJson(await _send('POST', '/api/backup'));

  Future<List<AuditEntry>> audit({int limit = 60}) async {
    final json = await _send('GET', '/api/audit', query: {'limit': '$limit'});
    return (json['entries'] as List<dynamic>)
        .map((e) => AuditEntry.fromJson(e as Map<String, dynamic>))
        .toList();
  }
}
