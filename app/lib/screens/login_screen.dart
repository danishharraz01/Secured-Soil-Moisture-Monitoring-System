/// Screen 1 - server URL, username, password -> Continue.
library;

import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/app_controller.dart';
import '../core/validation.dart';
import '../theme.dart';
import '../widgets/common.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _form = GlobalKey<FormState>();
  late final _url = TextEditingController(text: widget.controller.serverUrl);
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _showPassword = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final password = _password.text;
    _password.clear(); // the password is never kept after this step
    try {
      await widget.controller.login(_url.text.trim(), _username.text, password);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final message = widget.controller.loginMessage;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const BrandHeader(
                      subtitle: 'Secured soil moisture monitoring for celery',
                    ),
                    const SizedBox(height: 28),
                    if (message != null) ...[
                      InfoBanner(
                        text: message,
                        color: Palette.amber,
                        background: Palette.amberSoft,
                        icon: Icons.info_outline,
                      ),
                      const SizedBox(height: 16),
                    ],
                    TextFormField(
                      key: const Key('serverUrl'),
                      controller: _url,
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      decoration: const InputDecoration(
                        labelText: 'Server URL',
                        prefixIcon: Icon(Icons.lock_outline),
                        helperText:
                            'HTTPS only - the server certificate is pinned',
                      ),
                      validator: validateServerUrl,
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      key: const Key('username'),
                      controller: _username,
                      autocorrect: false,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                        labelText: 'Username',
                        prefixIcon: Icon(Icons.person_outline),
                      ),
                      validator: (v) => (v ?? '').trim().isEmpty
                          ? 'Enter your username'
                          : null,
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      key: const Key('password'),
                      controller: _password,
                      obscureText: !_showPassword,
                      enableSuggestions: false,
                      autocorrect: false,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _busy ? null : _submit(),
                      decoration: InputDecoration(
                        labelText: 'Password',
                        prefixIcon: const Icon(Icons.key_outlined),
                        suffixIcon: IconButton(
                          tooltip: _showPassword
                              ? 'Hide password'
                              : 'Show password',
                          icon: Icon(
                            _showPassword
                                ? Icons.visibility_off
                                : Icons.visibility,
                          ),
                          onPressed: () =>
                              setState(() => _showPassword = !_showPassword),
                        ),
                      ),
                      validator: (v) =>
                          (v ?? '').isEmpty ? 'Enter your password' : null,
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
                      key: const Key('continue'),
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(
                                strokeWidth: 2.5,
                              ),
                            )
                          : const Text('Continue'),
                    ),
                    const SizedBox(height: 18),
                    const Text(
                      'After your password you will receive a 6-digit code by email. '
                      'Sessions end automatically after 10 minutes.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Palette.muted, fontSize: 13),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
