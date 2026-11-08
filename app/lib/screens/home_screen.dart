/// Screen 3 - bottom tabs: Dashboard, Activity, Report, Settings.
///
///  - polls the dashboard data every 3 s while the app is in the foreground
///  - counts the session down every second; at 00:00 -> back to login
///  - any 401 from the server -> back to login with the server's reason
///  - new alerts -> local notifications
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/app_controller.dart';
import '../core/countdown.dart';
import '../models/models.dart';
import 'activity_tab.dart';
import 'dashboard_tab.dart';
import 'report_tab.dart';
import 'settings_tab.dart';

const pollInterval = Duration(seconds: 3);

class DashboardData {
  const DashboardData({
    required this.devices,
    required this.readings,
    required this.alerts,
  });
  final DevicesSnapshot devices;
  final List<Reading> readings;
  final AlertsPage alerts;
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  int _tab = 0;
  DashboardData? _data;
  String? _error;
  bool _refreshing = false;
  Timer? _poll;
  Timer? _clock;

  AppController get _c => widget.controller;
  ApiClient get _api => _c.api!;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _start();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _stop();
    super.dispose();
  }

  void _start() {
    _stop();
    unawaited(refresh());
    _poll = Timer.periodic(pollInterval, (_) => refresh());
    _clock = Timer.periodic(const Duration(seconds: 1), (_) => _tick());
  }

  void _stop() {
    _poll?.cancel();
    _clock?.cancel();
    _poll = _clock = null;
  }

  /// Poll only while the app is visible; re-check the session when it returns.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _tick();
      _start();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _stop();
    }
  }

  void _tick() {
    final session = _c.session;
    if (session == null) return;
    if (remaining(session.expiresAt) == Duration.zero) {
      _stop();
      unawaited(_c.sessionEnded());
    } else if (mounted) {
      setState(() {}); // repaint the countdown
    }
  }

  /// Tabs report API errors here: 401 ends the session, others show a message.
  void onApiError(ApiException e) {
    if (e.sessionEnded) {
      _stop();
      unawaited(_c.sessionEnded(e.message));
    } else if (mounted) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> refresh() async {
    if (_refreshing || _c.api == null) return;
    _refreshing = true;
    try {
      final results = await Future.wait([
        _api.devices(),
        _api.readings(limit: 150),
        _api.alerts(),
      ]);
      final data = DashboardData(
        devices: results[0] as DevicesSnapshot,
        readings: results[1] as List<Reading>,
        alerts: results[2] as AlertsPage,
      );
      await _c.notifier.onAlerts(data.alerts);
      if (mounted) {
        setState(() {
          _data = data;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (e.sessionEnded) return onApiError(e);
      if (mounted) {
        setState(() => _error = e.message); // keep showing the last data
      }
    } on FormatException catch (e) {
      if (mounted) {
        setState(
          () => _error = 'Unexpected data from the server (${e.message})',
        );
      }
    } finally {
      _refreshing = false;
    }
  }

  Future<void> _confirmLogout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Log out?'),
        content: const Text(
          'You will need your password and a new email code to log in again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Log out'),
          ),
        ],
      ),
    );
    if (ok == true) {
      _stop();
      await _c.logout();
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = _c.session!;
    final left = remaining(session.expiresAt);
    final tabs = [
      DashboardTab(
        session: session,
        countdown: formatCountdown(left),
        endingSoon: left.inSeconds < 60,
        data: _data,
        error: _error,
        onRefresh: refresh,
        onLogout: _confirmLogout,
      ),
      ActivityTab(api: _api, onApiError: onApiError),
      ReportTab(api: _api, onApiError: onApiError),
      SettingsTab(
        api: _api,
        session: session,
        serverUrl: _c.serverUrl,
        onApiError: onApiError,
      ),
    ];
    const titles = ['Soil Monitor', 'Activity', 'Daily report', 'Settings'];
    return Scaffold(
      appBar: AppBar(title: Text(titles[_tab])),
      body: SafeArea(child: tabs[_tab]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.dashboard_outlined),
            selectedIcon: Icon(Icons.dashboard),
            label: 'Dashboard',
          ),
          NavigationDestination(icon: Icon(Icons.history), label: 'Activity'),
          NavigationDestination(
            icon: Icon(Icons.insert_chart_outlined),
            selectedIcon: Icon(Icons.insert_chart),
            label: 'Report',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: 'Settings',
          ),
        ],
      ),
    );
  }
}
