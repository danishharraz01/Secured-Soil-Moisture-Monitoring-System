/// Settings: thresholds (admin edits, viewer read-only), integrity check,
/// cloud backup (admin) and the audit log (admin, suspicious actions in red).
library;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../core/api_client.dart';
import '../core/validation.dart';
import '../models/models.dart';
import '../theme.dart';
import '../widgets/common.dart';

class SettingsTab extends StatefulWidget {
  const SettingsTab({
    super.key,
    required this.api,
    required this.session,
    required this.serverUrl,
    required this.onApiError,
  });

  final ApiClient api;
  final Session session;
  final String serverUrl;
  final void Function(ApiException) onApiError;

  @override
  State<SettingsTab> createState() => _SettingsTabState();
}

class _SettingsTabState extends State<SettingsTab> {
  final _low = TextEditingController();
  final _high = TextEditingController();
  ThresholdConfig? _config;
  String? _thresholdError;
  bool _saving = false;

  VerifyResult? _verify;
  bool _verifying = false;

  BackupInfo? _backup;
  bool _backingUp = false;

  List<AuditEntry>? _audit;

  bool get _admin => widget.session.isAdmin;

  @override
  void initState() {
    super.initState();
    _loadConfig();
    if (_admin) _loadAudit();
  }

  @override
  void dispose() {
    _low.dispose();
    _high.dispose();
    super.dispose();
  }

  /// Runs an API call; 401 ends the session, other errors become a snackbar.
  Future<T?> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } on ApiException catch (e) {
      widget.onApiError(e);
      return null;
    }
  }

  Future<void> _loadConfig() async {
    final c = await _call(widget.api.config);
    if (c == null || !mounted) return;
    setState(() => _config = c);
    _low.text = c.low.toString();
    _high.text = c.high.toString();
  }

  Future<void> _loadAudit() async {
    final a = await _call(widget.api.audit);
    if (a != null && mounted) setState(() => _audit = a);
  }

  Future<void> _saveThresholds() async {
    final low = double.tryParse(_low.text.replaceAll(',', '.'));
    final high = double.tryParse(_high.text.replaceAll(',', '.'));
    final error = thresholdError(low, high);
    setState(() => _thresholdError = error);
    if (error != null) return;
    setState(() => _saving = true);
    final c = await _call(() => widget.api.updateConfig(low!, high!));
    if (!mounted) return;
    setState(() => _saving = false);
    if (c != null) {
      setState(() => _config = c);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Saved: pump ON ≤ ${c.low} mm, OFF ≥ ${c.high} mm. The device applies it on its next signed reply.',
          ),
        ),
      );
      _loadAudit();
    }
  }

  Future<void> _runVerify() async {
    setState(() {
      _verifying = true;
      _verify = null;
    });
    final r = await _call(widget.api.verify);
    if (mounted) {
      setState(() {
        _verifying = false;
        _verify = r;
      });
    }
  }

  Future<void> _runBackup() async {
    setState(() {
      _backingUp = true;
      _backup = null;
    });
    final b = await _call(widget.api.backup);
    if (mounted) {
      setState(() {
        _backingUp = false;
        _backup = b;
      });
    }
    if (b != null) _loadAudit();
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _thresholdsCard(),
        const SizedBox(height: 12),
        _integrityCard(),
        if (_admin) ...[
          const SizedBox(height: 12),
          _backupCard(),
          const SizedBox(height: 12),
          _auditCard(),
        ],
        const SizedBox(height: 12),
        SectionCard(
          title: 'Connection',
          child: Text(
            '${widget.serverUrl}\nHTTPS with a pinned certificate · session token in encrypted storage',
            style: const TextStyle(color: Palette.muted, height: 1.4),
          ),
        ),
      ],
    );
  }

  Widget _thresholdsCard() {
    final c = _config;
    if (c == null) {
      return const SectionCard(
        title: 'Watering thresholds',
        child: LoadState(),
      );
    }
    if (!_admin) {
      return SectionCard(
        title: 'Watering thresholds',
        child: Text(
          'Pump ON at ≤ ${c.low} mm, OFF at ≥ ${c.high} mm.\nOnly the admin can change these.',
          style: const TextStyle(height: 1.5),
        ),
      );
    }
    InputDecoration deco(String label) =>
        InputDecoration(labelText: label, suffixText: 'mm', isDense: true);
    return SectionCard(
      title: 'Watering thresholds',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  key: const Key('low'),
                  controller: _low,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: deco('Pump ON at ≤'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  key: const Key('high'),
                  controller: _high,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: deco('Pump OFF at ≥'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            _thresholdError ??
                'Rules: ON ≥ 5 mm, OFF ≤ 50 mm, at least 2 mm apart.',
            style: TextStyle(
              color: _thresholdError == null ? Palette.muted : Palette.red,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 10),
          FilledButton(
            onPressed: _saving ? null : _saveThresholds,
            child: Text(_saving ? 'Saving…' : 'Save thresholds'),
          ),
        ],
      ),
    );
  }

  Widget _integrityCard() {
    final v = _verify;
    return SectionCard(
      title: 'Data integrity',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Every reading is linked to the previous one with an HMAC. Editing, deleting or reordering stored readings is detected.',
            style: TextStyle(color: Palette.muted, fontSize: 13),
          ),
          const SizedBox(height: 10),
          if (v != null) ...[
            v.ok
                ? InfoBanner(
                    text: 'OK - all ${v.count} readings verified, no tampering',
                    color: Palette.green,
                    background: Palette.greenSoft,
                    icon: Icons.verified_outlined,
                  )
                : InfoBanner(
                    text:
                        'Tampering detected at reading #${v.brokenAt ?? '?'}\n${v.reason ?? ''}',
                    color: Palette.red,
                    background: Palette.redSoft,
                    icon: Icons.gpp_bad_outlined,
                  ),
            const SizedBox(height: 10),
          ],
          OutlinedButton.icon(
            onPressed: _verifying ? null : _runVerify,
            icon: const Icon(Icons.fact_check_outlined),
            label: Text(_verifying ? 'Checking…' : 'Run integrity check'),
          ),
        ],
      ),
    );
  }

  Widget _backupCard() {
    final b = _backup;
    return SectionCard(
      title: 'Encrypted cloud backup',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Automatic every 10 minutes. AES-256-GCM, key wrapped with RSA-3072 - only the offline key can decrypt it.',
            style: TextStyle(color: Palette.muted, fontSize: 13),
          ),
          const SizedBox(height: 10),
          if (b != null) ...[
            InfoBanner(
              text:
                  'Saved ${b.file}\n${b.readings} readings, ${(b.bytes / 1024).toStringAsFixed(0)} KB, signed',
              color: Palette.green,
              background: Palette.greenSoft,
              icon: Icons.cloud_done_outlined,
            ),
            const SizedBox(height: 10),
          ],
          OutlinedButton.icon(
            onPressed: _backingUp ? null : _runBackup,
            icon: const Icon(Icons.cloud_upload_outlined),
            label: Text(_backingUp ? 'Backing up…' : 'Back up to cloud now'),
          ),
        ],
      ),
    );
  }

  Widget _auditCard() {
    final entries = _audit;
    final time = DateFormat('d MMM HH:mm:ss');
    return SectionCard(
      title: 'Audit log',
      trailing: IconButton(
        tooltip: 'Reload',
        onPressed: _loadAudit,
        icon: const Icon(Icons.refresh),
      ),
      child: entries == null
          ? const LoadState()
          : Column(
              children: [
                for (final e in entries.take(40))
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    leading: Icon(
                      e.suspicious
                          ? Icons.warning_amber_rounded
                          : Icons.check_circle_outline,
                      color: e.suspicious ? Palette.red : Palette.muted,
                    ),
                    title: Text(
                      '${e.action} · ${e.actor}',
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: e.suspicious ? Palette.red : Palette.ink,
                      ),
                    ),
                    subtitle: Text(
                      '${e.detail}\n${time.format(e.at)}${e.ip == null ? '' : ' · ${e.ip}'}',
                    ),
                    isThreeLine: true,
                  ),
              ],
            ),
    );
  }
}
