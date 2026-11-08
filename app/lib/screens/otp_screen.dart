/// Screen 2 - the 6-digit code sent by email. One wrong code -> back to login.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api_client.dart';
import '../core/app_controller.dart';
import '../core/validation.dart';
import '../theme.dart';
import '../widgets/common.dart';

class OtpScreen extends StatefulWidget {
  const OtpScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends State<OtpScreen> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _verify() async {
    final code = _code.text.trim();
    if (!isOtpCode(code)) {
      setState(() => _error = 'Enter the 6-digit code from the email');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.controller.verifyOtp(
        code,
      ); // wrong code -> controller returns to login
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final challenge = widget.controller.challenge;
    final minutes = ((challenge?.expiresIn ?? 300) / 60).round();
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          icon: const Icon(Icons.arrow_back),
          onPressed: _busy ? null : () => widget.controller.backToLogin(),
        ),
        title: const Text('Verify it\'s you'),
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(
                    Icons.mark_email_read_outlined,
                    size: 56,
                    color: Palette.green,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'We sent a 6-digit code to ${challenge?.sentTo ?? 'your email'}',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'It expires in $minutes minutes and works once. One wrong code cancels it.',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Palette.muted),
                  ),
                  const SizedBox(height: 24),
                  TextField(
                    key: const Key('otp'),
                    controller: _code,
                    autofocus: true,
                    keyboardType: TextInputType.number,
                    textAlign: TextAlign.center,
                    maxLength: 6,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    style: const TextStyle(
                      fontSize: 28,
                      letterSpacing: 10,
                      fontWeight: FontWeight.w600,
                    ),
                    decoration: const InputDecoration(
                      counterText: '',
                      hintText: '000000',
                    ),
                    onSubmitted: (_) => _busy ? null : _verify(),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    InfoBanner(
                      text: _error!,
                      color: Palette.red,
                      background: Palette.redSoft,
                      icon: Icons.error_outline,
                    ),
                  ],
                  const SizedBox(height: 22),
                  FilledButton(
                    key: const Key('verify'),
                    onPressed: _busy ? null : _verify,
                    child: _busy
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2.5),
                          )
                        : const Text('Verify'),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => widget.controller.backToLogin(),
                    child: const Text('Back to login'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
