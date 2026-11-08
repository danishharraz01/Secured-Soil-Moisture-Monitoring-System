/// Daily report: summary for one (device) day, with a date picker.
library;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../core/api_client.dart';
import '../models/models.dart';
import '../theme.dart';
import '../widgets/common.dart';

class ReportTab extends StatefulWidget {
  const ReportTab({super.key, required this.api, required this.onApiError});

  final ApiClient api;
  final void Function(ApiException) onApiError;

  @override
  State<ReportTab> createState() => _ReportTabState();
}

class _ReportTabState extends State<ReportTab> {
  DailyReport? _report;
  String? _error;
  static final _apiDate = DateFormat('yyyy-MM-dd');

  @override
  void initState() {
    super.initState();
    _load(); // no date -> the server picks the device's current day
  }

  Future<void> _load([String? date]) async {
    setState(() {
      _report = null;
      _error = null;
    });
    try {
      final r = await widget.api.report(date: date);
      if (mounted) setState(() => _report = r);
    } on ApiException catch (e) {
      if (e.sessionEnded) return widget.onApiError(e);
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _pickDate() async {
    final current = _report == null
        ? DateTime.now()
        : DateTime.parse(_report!.date);
    final picked = await showDatePicker(
      context: context,
      initialDate: current,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
      helpText: 'Report for (device) day',
    );
    if (picked != null) await _load(_apiDate.format(picked));
  }

  @override
  Widget build(BuildContext context) {
    final r = _report;
    String mm(double? v) => v == null ? '--' : '${v.toStringAsFixed(1)} mm';
    return RefreshIndicator(
      onRefresh: () => _load(r?.date),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              leading: const Icon(
                Icons.calendar_today_outlined,
                color: Palette.green,
              ),
              title: Text(
                r == null
                    ? 'Loading…'
                    : DateFormat('EEEE, d MMMM yyyy')
                          .format(DateTime.parse(r.date)),
              ),
              subtitle: Text(r == null ? '' : '${r.readings} readings'),
              trailing: TextButton(
                onPressed: _pickDate,
                child: const Text('Change'),
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (r == null)
            LoadState(error: _error, onRetry: _load)
          else
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 1.6,
              children: [
                StatCard(
                  label: 'Average moisture',
                  icon: Icons.water_outlined,
                  value: mm(r.avgMoistureMm),
                ),
                StatCard(
                  label: 'Min / max',
                  icon: Icons.unfold_more,
                  value:
                      '${r.minMoistureMm?.toStringAsFixed(1) ?? '--'} / ${r.maxMoistureMm?.toStringAsFixed(1) ?? '--'}',
                  detail: 'mm',
                ),
                StatCard(
                  label: 'Waterings',
                  icon: Icons.water_drop_outlined,
                  value: '${r.waterings}',
                  color: Palette.blue,
                ),
                StatCard(
                  label: 'Water used',
                  icon: Icons.local_drink_outlined,
                  value: '${r.totalWaterMl} ml',
                ),
                StatCard(
                  label: 'Motion events',
                  icon: Icons.directions_run,
                  value: '${r.motionCount}',
                  color: r.motionCount > 0 ? Palette.amber : Palette.ink,
                ),
                StatCard(
                  label: 'Offline',
                  icon: Icons.wifi_off,
                  value: '${r.offlineMinutes} min',
                  color: r.offlineMinutes > 0 ? Palette.red : Palette.ink,
                ),
              ],
            ),
        ],
      ),
    );
  }
}
