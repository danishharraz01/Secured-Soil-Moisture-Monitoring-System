/// Soil Monitor - mobile app of the Secured Soil Moisture Monitoring System.
library;

import 'package:flutter/material.dart';

import 'core/app_controller.dart';
import 'core/notifications.dart';
import 'core/session_store.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/otp_screen.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final notifier = LocalAlertNotifier();
  await notifier.init();
  final controller = AppController(
    store: SecureSessionStore(),
    notifier: notifier,
  );
  runApp(SoilMonitorApp(controller: controller));
  await controller.init();
}

class SoilMonitorApp extends StatelessWidget {
  const SoilMonitorApp({super.key, required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Soil Monitor',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: ListenableBuilder(
        listenable: controller,
        builder: (context, _) => switch (controller.stage) {
          AuthStage.loading => const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          ),
          AuthStage.login => LoginScreen(controller: controller),
          AuthStage.otp => OtpScreen(controller: controller),
          AuthStage.home => HomeScreen(controller: controller),
        },
      ),
    );
  }
}
