/// Dashboard: session header, status cards, moisture chart, latest notifications.
library;

import 'package:flutter/material.dart';

import '../core/countdown.dart';
import '../models/models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/moisture_chart.dart';
import 'home_screen.dart';

class DashboardTab extends StatelessWidget {
  const DashboardTab({
    super.key,
    required this.session,
    required this.countdown,
    required this.endingSoon,
    required this.data,
    required this.error,
    required this.onRefresh,
    required this.onLogout,
  });

  final Session session;
  final String countdown;
  final bool endingSoon;
  final DashboardData? data;
  final String? error;
  final Future<void> Function() onRefresh;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    final d = data;
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _SessionHeader(
            session: session,
            countdown: countdown,
            endingSoon: endingSoon,
            onLogout: onLogout,
          ),
          const SizedBox(height: 12),
          if (error != null) ...[
            InfoBanner(
              text: error!,
              color: Palette.red,
              background: Palette.redSoft,
              icon: Icons.cloud_off,
            ),
            const SizedBox(height: 12),
          ],
          if (d == null && error == null) const LoadState(),
          if (d != null) ..._content(d),
        ],
      ),
    );
  }

  List<Widget> _content(DashboardData d) {
    if (d.devices.devices.isEmpty) return const [Text('No device registered')];
    final device = d.devices.devices.first;
    final motion = device.motionActive(d.devices.serverTime);
    final lastSeen = device.lastSeenAt == null
        ? 'never'
        : timeAgo(device.lastSeenAt!, now: d.devices.serverTime);
    final moisture = device.moistureMm;

    return [
      if (!device.online) ...[
        InfoBanner(
          text:
              'Device disconnected - no heartbeat since $lastSeen. Watering continues on the device.',
          color: Palette.red,
          background: Palette.redSoft,
          icon: Icons.wifi_off,
        ),
        const SizedBox(height: 12),
      ],
      GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 12,
        crossAxisSpacing: 12,
        childAspectRatio: 1.45,
        children: [
          StatCard(
            label: 'Soil moisture',
            icon: Icons.water_outlined,
            value: moisture == null
                ? '--'
                : '${moisture.toStringAsFixed(1)} mm',
            detail: 'ON ≤ ${device.low} · OFF ≥ ${device.high} mm',
          ),
          StatCard(
            label: 'Water pump',
            icon: Icons.water_drop_outlined,
            value: device.pumpOn ? 'Watering' : 'Off',
            color: device.pumpOn ? Palette.blue : Palette.ink,
            detail: device.pumpOn ? 'Relay closed' : 'Relay open',
          ),
          StatCard(
            label: 'Device',
            icon: Icons.memory,
            value: device.online ? 'Online' : 'Offline',
            color: device.online ? Palette.green : Palette.red,
            detail: 'Last seen $lastSeen',
          ),
          StatCard(
            label: 'Motion sensor',
            icon: Icons.sensors,
            value: motion ? 'Motion!' : 'Clear',
            color: motion ? Palette.red : Palette.ink,
            dotColor: motion ? Palette.red : const Color(0xFFB0BEC5),
            detail: device.lastMotionAt == null
                ? 'No motion yet'
                : 'Last: ${timeAgo(device.lastMotionAt!, now: d.devices.serverTime)}',
          ),
        ],
      ),
      const SizedBox(height: 12),
      StatCard(
        label: 'Water used today (device day)',
        icon: Icons.local_drink_outlined,
        value: '${device.waterTodayMl} ml',
      ),
      const SizedBox(height: 12),
      SectionCard(
        title: 'Soil moisture (last ${d.readings.length} readings)',
        trailing: const _Legend(),
        child: MoistureChart(
          readings: d.readings,
          low: device.low,
          high: device.high,
        ),
      ),
      const SizedBox(height: 12),
      SectionCard(
        title: 'Latest notifications',
        child: d.alerts.alerts.isEmpty
            ? const Text(
                'No notifications yet',
                style: TextStyle(color: Palette.muted),
              )
            : Column(
                children: [
                  for (final a in d.alerts.alerts.take(4)) AlertTile(alert: a),
                ],
              ),
      ),
    ];
  }
}

class _SessionHeader extends StatelessWidget {
  const _SessionHeader({
    required this.session,
    required this.countdown,
    required this.endingSoon,
    required this.onLogout,
  });

  final Session session;
  final String countdown;
  final bool endingSoon;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        child: Row(
          children: [
            CircleAvatar(
              backgroundColor: Palette.greenSoft,
              child: Text(
                session.username[0].toUpperCase(),
                style: const TextStyle(
                  color: Palette.green,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${session.username} · ${session.isAdmin ? 'Admin' : 'Viewer'}',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  Text(
                    'Session ends in $countdown',
                    key: const Key('countdown'),
                    style: TextStyle(
                      color: endingSoon ? Palette.red : Palette.muted,
                      fontSize: 13,
                    ),
                  ),
                ],
              ),
            ),
            TextButton.icon(
              onPressed: onLogout,
              icon: const Icon(Icons.logout, size: 18),
              label: const Text('Log out'),
            ),
          ],
        ),
      ),
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend();

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 12,
          height: 12,
          color: Palette.blue.withValues(alpha: 0.18),
        ),
        const SizedBox(width: 4),
        const Text(
          'pump on',
          style: TextStyle(fontSize: 11, color: Palette.muted),
        ),
      ],
    );
  }
}
