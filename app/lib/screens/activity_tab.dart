/// Activity: pump on/off, motion and offline/online history with filter chips.
library;

import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../models/models.dart';
import '../theme.dart';
import '../widgets/common.dart';

class ActivityTab extends StatefulWidget {
  const ActivityTab({super.key, required this.api, required this.onApiError});

  final ApiClient api;
  final void Function(ApiException) onApiError;

  @override
  State<ActivityTab> createState() => _ActivityTabState();
}

/// Filter chip label -> API type (null = all).
const activityFilters = <String, String?>{
  'All': null,
  'Pump on': 'pump_on',
  'Pump off': 'pump_off',
  'Motion': 'motion',
  'Offline': 'offline',
  'Online': 'online',
};

class _ActivityTabState extends State<ActivityTab> {
  String _filter = 'All';
  List<AlertItem>? _events;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final events = await widget.api.activity(type: activityFilters[_filter]);
      if (mounted) {
        setState(() {
          _events = events;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (e.sessionEnded) return widget.onApiError(e);
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        SizedBox(
          height: 56,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            children: [
              for (final label in activityFilters.keys)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: FilterChip(
                    label: Text(label),
                    selected: _filter == label,
                    selectedColor: Palette.greenSoft,
                    onSelected: (_) {
                      setState(() {
                        _filter = label;
                        _events = null;
                      });
                      _load();
                    },
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: _events == null
                ? ListView(
                    children: [LoadState(error: _error, onRetry: _load)],
                  )
                : _events!.isEmpty
                ? ListView(
                    children: const [
                      Padding(
                        padding: EdgeInsets.all(32),
                        child: Text(
                          'Nothing recorded yet',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Palette.muted),
                        ),
                      ),
                    ],
                  )
                : ListView.separated(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    itemCount: _events!.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (_, i) => AlertTile(alert: _events![i]),
                  ),
          ),
        ),
      ],
    );
  }
}
