/// The bridge's own event log — what happened, when, and never a
/// secret. Spec §27: log the pipeline (`Firebase connected`, `Report
/// claimed`, `Telegram send successful`, …) and NEVER the bot token.
///
/// Every line passes through [redact], which strips any token-shaped
/// segment out of Bot API URLs before a message can reach the buffer,
/// the screen or the debug console.
library;

import 'package:flutter/foundation.dart';

class BridgeLogEntry {
  BridgeLogEntry(this.at, this.message);
  final DateTime at;
  final String message;

  String get stamp =>
      '${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';
}

class LogService {
  LogService._();
  static final LogService instance = LogService._();

  static const int _capacity = 200;
  final List<BridgeLogEntry> _entries = <BridgeLogEntry>[];
  final ValueNotifier<List<BridgeLogEntry>> entries =
      ValueNotifier<List<BridgeLogEntry>>(const <BridgeLogEntry>[]);

  /// `bot123456:AAxyz…` anywhere in a string → `bot***`.
  static String redact(String message) =>
      message.replaceAll(RegExp('bot[0-9]{5,}:[A-Za-z0-9_-]+'), 'bot***');

  void info(String message) => _add('info', message);
  void error(String message) => _add('error', message);

  void _add(String level, String message) {
    final String safe = redact(message);
    debugPrint('[leadger-bridge] $safe');
    _entries.add(BridgeLogEntry(DateTime.now(), '$level: $safe'));
    if (_entries.length > _capacity) _entries.removeAt(0);
    entries.value = List<BridgeLogEntry>.unmodifiable(_entries.reversed);
  }
}
