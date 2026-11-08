/// Small reusable widgets.
library;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../models/models.dart';
import '../theme.dart';

class BrandHeader extends StatelessWidget {
  const BrandHeader({super.key, required this.subtitle});

  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(
            color: Palette.greenSoft,
            borderRadius: BorderRadius.circular(18),
          ),
          child: const Icon(Icons.eco_outlined, color: Palette.green, size: 36),
        ),
        const SizedBox(height: 14),
        Text(
          'Soil Monitor',
          style: Theme.of(context).textTheme.headlineSmall
              ?.copyWith(fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 4),
        Text(
          subtitle,
          textAlign: TextAlign.center,
          style: const TextStyle(color: Palette.muted),
        ),
      ],
    );
  }
}

class InfoBanner extends StatelessWidget {
  const InfoBanner({
    super.key,
    required this.text,
    required this.color,
    required this.background,
    required this.icon,
  });

  final String text;
  final Color color;
  final Color background;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: TextStyle(color: color, fontWeight: FontWeight.w500),
            ),
          ),
        ],
      ),
    );
  }
}

/// A titled white card.
class SectionCard extends StatelessWidget {
  const SectionCard({
    super.key,
    required this.title,
    required this.child,
    this.trailing,
  });

  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    title,
                    style: const TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 15,
                    ),
                  ),
                ),
                ?trailing,
              ],
            ),
            const SizedBox(height: 12),
            child,
          ],
        ),
      ),
    );
  }
}

/// Dashboard tile: label, big value, optional detail line and leading dot.
class StatCard extends StatelessWidget {
  const StatCard({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    this.detail,
    this.color = Palette.ink,
    this.dotColor,
  });

  final String label;
  final String value;
  final IconData icon;
  final String? detail;
  final Color color;

  /// A small coloured dot before the value (e.g. the red motion LED).
  final Color? dotColor;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 18, color: Palette.muted),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    label,
                    style: const TextStyle(color: Palette.muted, fontSize: 13),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                if (dotColor != null) ...[
                  Container(
                    width: 12,
                    height: 12,
                    decoration: BoxDecoration(
                      color: dotColor,
                      shape: BoxShape.circle,
                      boxShadow: [
                        BoxShadow(
                          color: dotColor!.withValues(alpha: 0.5),
                          blurRadius: 6,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                ],
                Flexible(
                  child: Text(
                    value,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                      color: color,
                    ),
                  ),
                ),
              ],
            ),
            if (detail != null) ...[
              const SizedBox(height: 4),
              Text(
                detail!,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Palette.muted, fontSize: 12),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Icon + colours for each alert kind.
({IconData icon, Color color, Color background}) alertStyle(AlertKind kind) =>
    switch (kind) {
      AlertKind.pumpOn => (
        icon: Icons.water_drop,
        color: Palette.blue,
        background: Palette.blueSoft,
      ),
      AlertKind.pumpOff => (
        icon: Icons.water_drop_outlined,
        color: Palette.green,
        background: Palette.greenSoft,
      ),
      AlertKind.motion => (
        icon: Icons.directions_run,
        color: Palette.amber,
        background: Palette.amberSoft,
      ),
      AlertKind.offline => (
        icon: Icons.wifi_off,
        color: Palette.red,
        background: Palette.redSoft,
      ),
      AlertKind.online => (
        icon: Icons.wifi,
        color: Palette.green,
        background: Palette.greenSoft,
      ),
      AlertKind.tamper => (
        icon: Icons.gpp_bad_outlined,
        color: Palette.red,
        background: Palette.redSoft,
      ),
      AlertKind.unknown => (
        icon: Icons.notifications_none,
        color: Palette.muted,
        background: Palette.line,
      ),
    };

final _timeFormat = DateFormat('d MMM, HH:mm:ss');

class AlertTile extends StatelessWidget {
  const AlertTile({super.key, required this.alert});

  final AlertItem alert;

  @override
  Widget build(BuildContext context) {
    final style = alertStyle(alert.kind);
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: CircleAvatar(
        backgroundColor: style.background,
        child: Icon(style.icon, color: style.color, size: 20),
      ),
      title: Text(
        alert.title,
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Text('${alert.message}\n${_timeFormat.format(alert.at)}'),
      isThreeLine: true,
    );
  }
}

/// Centered spinner / error message with a retry button.
class LoadState extends StatelessWidget {
  const LoadState({super.key, this.error, this.onRetry});

  final String? error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    if (error == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: CircularProgressIndicator(),
        ),
      );
    }
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            InfoBanner(
              text: error!,
              color: Palette.red,
              background: Palette.redSoft,
              icon: Icons.cloud_off,
            ),
            if (onRetry != null)
              TextButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}
