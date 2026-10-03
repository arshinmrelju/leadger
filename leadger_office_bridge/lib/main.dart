/// Leadger Office Bridge — a small, always-on Android app whose only
/// job is to carry the day's closing report from Firestore to the
/// owner's Telegram (spec §2, §7). It reads, formats and delivers; it
/// never computes or modifies anything financial.
library;

import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'background/bridge_service.dart';
import 'screens/dashboard_screen.dart';
import 'screens/setup_screen.dart';
import 'storage/secure_storage_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // The port is what lets the boot-restarted service talk to a UI
  // isolate later; both must exist before the first frame.
  FlutterForegroundTask.initCommunicationPort();
  initForegroundService();
  final bool configured = await _isConfigured();
  runApp(LeadgerBridgeApp(initiallyConfigured: configured));
}

Future<bool> _isConfigured() async {
  final String? token = await SecureStorageService().readToken();
  final String? chatId = await SecureStorageService().readChatId();
  return token != null && token.isNotEmpty && chatId != null && chatId.isNotEmpty;
}

class LeadgerBridgeApp extends StatefulWidget {
  const LeadgerBridgeApp({super.key, required this.initiallyConfigured});
  final bool initiallyConfigured;

  @override
  State<LeadgerBridgeApp> createState() => _LeadgerBridgeAppState();
}

class _LeadgerBridgeAppState extends State<LeadgerBridgeApp> {
  late bool _configured;

  @override
  void initState() {
    super.initState();
    _configured = widget.initiallyConfigured;
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Leadger Office Bridge',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF132B1E)),
        useMaterial3: true,
      ),
      home: _configured
          ? DashboardScreen(onReset: () => setState(() => _configured = false))
          : SetupScreen(onSaved: () => setState(() => _configured = true)),
    );
  }
}
