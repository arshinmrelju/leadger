/// The Android foreground service (spec §23): a persistent
/// "Leadger Bridge — Telegram reporting active" notification that
/// keeps the process alive, restarts on boot and after the OS kills
/// the app, and supervises the delivery engine from a background
/// isolate.
///
/// Division of labour: the Firestore LISTENERS do detection; this
/// service's 30-second repeat event only re-attaches a broken engine
/// or re-probes a cold start — supervision, not a polling loop.
library;

import 'dart:async';

import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import '../services/firebase_service.dart';
import '../services/log_service.dart';
import '../services/report_delivery_service.dart';
import '../services/telegram_service.dart';
import '../storage/secure_storage_service.dart';

/// Build a fresh engine. Both isolates (UI and task) call this — each
/// gets its own Dart objects over the same plugin singletons, and the
/// atomic claim makes any overlap safe (spec §15, Test 11).
ReportDeliveryService buildBridgeEngine() => ReportDeliveryService(
      firebase: FirebaseService(),
      telegram: TelegramService(),
      storage: SecureStorageService(),
    );

void initForegroundService() {
  FlutterForegroundTask.init(
    androidNotificationOptions: AndroidNotificationOptions(
      channelId: 'leadger_bridge_service',
      channelName: 'Leadger Bridge',
      channelDescription: 'Keeps the Telegram daily-report bridge running.',
      onlyAlertOnce: true,
    ),
    iosNotificationOptions: const IOSNotificationOptions(showNotification: true),
    foregroundTaskOptions: ForegroundTaskOptions(
      // A gentle heartbeat, NOT the detection mechanism: Firestore
      // listeners already wake the queue the moment a day closes.
      // 30s exists to re-attach after a killed listener and to satisfy
      // Android's own expectations of a dataSync service.
      eventAction: ForegroundTaskEventAction.repeat(30000),
      autoRunOnBoot: true,
      autoRunOnMyPackageReplaced: true,
      allowWakeLock: true,
      allowWifiLock: true,
    ),
  );
}

/// Top-level because the plugin re-enters it by address after a boot
/// or a process restart (spec §23: recover after device reboot).
@pragma('vm:entry-point')
void bridgeStartCallback() {
  FlutterForegroundTask.setTaskHandler(BridgeTaskHandler());
}

class BridgeTaskHandler extends TaskHandler {
  ReportDeliveryService? _engine;

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    LogService.instance.info('Bridge foreground service started (${starter.name})');
    _engine = buildBridgeEngine();
    try {
      final BridgeAccess access = await _engine!.attach();
      LogService.instance.info('Initial attach: $access');
    } catch (err) {
      LogService.instance.error('Initial attach failed: $err');
    }
  }

  @override
  void onRepeatEvent(DateTime timestamp) {
    // Cheap: with listeners attached this is just a sweep; after a
    // listener error or a cold start it re-probes (rate-limited
    // inside attach()).
    unawaited(_safeAttach());
  }

  Future<void> _safeAttach() async {
    try {
      await _engine?.attach();
    } catch (err) {
      LogService.instance.error('Heartbeat attach failed: $err');
    }
  }

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
    LogService.instance.info('Bridge foreground service destroyed (timeout: $isTimeout)');
    _engine?.close();
    _engine = null;
  }

  @override
  void onReceiveData(Object data) {}

  @override
  void onNotificationButtonPressed(String id) {}

  @override
  void onNotificationPressed() {}

  @override
  void onNotificationDismissed() {}
}

/// Start (or restart) the persistent service. Called from the setup
/// screen after configuration is saved, and from the dashboard.
Future<void> startBridgeService() async {
  if (await FlutterForegroundTask.isRunningService) {
    await FlutterForegroundTask.restartService();
  } else {
    await FlutterForegroundTask.startService(
      serviceId: 256,
      notificationTitle: 'Leadger Bridge',
      notificationText: 'Telegram reporting active',
      callback: bridgeStartCallback,
    );
  }
  LogService.instance.info('Foreground service requested');
}

Future<void> stopBridgeService() async {
  if (await FlutterForegroundTask.isRunningService) {
    await FlutterForegroundTask.stopService();
    LogService.instance.info('Foreground service stopped');
  }
}

Future<bool> isBridgeServiceRunning() => FlutterForegroundTask.isRunningService;
