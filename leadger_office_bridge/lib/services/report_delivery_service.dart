/// The delivery orchestrator (spec §18): read pending reports, claim
/// one atomically, format it from Leadger's own numbers, send it, and
/// record exactly what Telegram said. Firebase interaction lives in
/// [FirebaseService], HTTP in [TelegramService] — this class is the
/// seam between them and owns the retry schedule.
///
/// Detection is LISTENER-DRIVEN (spec §13): three Firestore streams
/// (pending / sending / failed) wake the queue the moment a day is
/// closed anywhere. [checkNow] exists for manual recovery and as the
/// foreground service's gentle heartbeat, never as a tight poll.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/daily_report.dart';
import '../models/delivery_policy.dart';
import '../models/report_text.dart';
import '../storage/secure_storage_service.dart';
import 'firebase_service.dart';
import 'log_service.dart';
import 'telegram_service.dart';

class ReportDeliveryService {
  ReportDeliveryService({
    required this.firebase,
    required this.telegram,
    required this.storage,
  });

  final FirebaseService firebase;
  final TelegramService telegram;
  final SecureStorageService storage;

  final LogService _log = LogService.instance;

  StreamSubscription<List<DailyReport>>? _pendingSub;
  StreamSubscription<List<DailyReport>>? _sendingSub;
  StreamSubscription<List<DailyReport>>? _failedSub;
  Timer? _retryTimer;
  bool _processing = false;
  bool _listenersAttached = false;

  List<DailyReport> _pending = const <DailyReport>[];
  List<DailyReport> _sending = const <DailyReport>[];
  List<DailyReport> _failed = const <DailyReport>[];

  /// Non-null while Telegram configuration is broken (invalid token /
  /// wrong chat id) — the dashboard shows it as a configuration error
  /// rather than pretending delivery is merely slow (spec §28).
  final ValueNotifier<String?> configError = ValueNotifier<String?>(null);

  /// Reports the queue currently knows about, newest close first.
  List<DailyReport> findPendingReports() =>
      <DailyReport>[..._pending, ..._sending, ..._failed];

  /// Sign in, prove the claim, attach listeners, sweep once. Safe to
  /// call repeatedly (button, heartbeat, app start).
  DateTime? _lastProbe;
  BridgeAccess? _lastAccess;
  Timer? _reprobeTimer;

  Future<BridgeAccess> attach() async {
    if (_listenersAttached) {
      // Listeners are the detection mechanism; with them alive this is
      // just the sweep.
      await processQueue();
      return BridgeAccess.ready;
    }
    final DateTime now = DateTime.now();
    if (_lastProbe != null &&
        now.difference(_lastProbe!) < const Duration(seconds: 45)) {
      return _lastAccess ?? BridgeAccess.offline;
    }
    _lastProbe = now;
    final BridgeAccess access = await firebase.ensureAccess();
    _lastAccess = access;
    if (access != BridgeAccess.ready) {
      // Offline or unprovisioned: keep supervising, but never faster
      // than the probe window above.
      _reprobeTimer?.cancel();
      _reprobeTimer =
          Timer(const Duration(seconds: 60), () => unawaited(_safeReprobe()));
    }
    if (access == BridgeAccess.ready && !_listenersAttached) {
      _pendingSub = firebase.watchByStatus(ReportStatus.pending).listen(
          (r) => _onQueueChanged(ReportStatus.pending, r), onError: _onListenerError);
      _sendingSub = firebase.watchByStatus(ReportStatus.sending).listen(
          (r) => _onQueueChanged(ReportStatus.sending, r), onError: _onListenerError);
      _failedSub = firebase.watchByStatus(ReportStatus.failed).listen(
          (r) => _onQueueChanged(ReportStatus.failed, r), onError: _onListenerError);
      _listenersAttached = true;
      _log.info('Pending-report listeners attached');
    }
    if (access == BridgeAccess.ready) await processQueue();
    return access;
  }

  Future<void> _safeReprobe() async {
    try {
      await attach();
    } catch (err) {
      _log.error('Re-probe failed: $err');
    }
  }

  void detach() {
    _reprobeTimer?.cancel();
    _pendingSub?.cancel();
    _sendingSub?.cancel();
    _failedSub?.cancel();
    _retryTimer?.cancel();
    _pendingSub = _sendingSub = _failedSub = null;
    _listenersAttached = false;
  }

  void _onListenerError(Object err) {
    _log.error('Report listener error: $err');
    _listenersAttached = false; // next attach() re-subscribes
  }

  void _onQueueChanged(ReportStatus status, List<DailyReport> reports) {
    switch (status) {
      case ReportStatus.pending:
        _pending = reports;
      case ReportStatus.sending:
        _sending = reports;
      case ReportStatus.failed:
        _failed = reports;
      case ReportStatus.sent:
        break;
    }
    processQueue();
  }

  /// Manual recovery ([Check Now] on the dashboard) and the foreground
  /// service heartbeat both land here; idempotent by construction.
  Future<BridgeAccess> checkNow() => attach();

  /// Single-flight sweep over every report the listeners know about.
  /// Concurrent calls collapse into the run in progress, so a burst of
  /// listener events can never launch two sends for one day (the
  /// atomic claim would refuse the second anyway — spec §15 — but the
  /// queue should not even try).
  Future<void> processQueue() async {
    if (_processing) return;
    _processing = true;
    try {
      final _Config? cfg = await _loadConfig();
      if (cfg == null) {
        _scheduleRetry(const Duration(minutes: 1));
        return;
      }
      for (final DailyReport report in findPendingReports()) {
        if (!DeliveryPolicy.eligibleForClaim(report, DateTime.now().toUtc())) {
          continue;
        }
        await _deliverOne(report, cfg);
      }
      _scheduleRetry(null);
    } catch (err) {
      _log.error('Queue sweep failed: $err');
      _scheduleRetry(const Duration(seconds: 30));
    } finally {
      _processing = false;
    }
  }

  /// claim → send → markSent, with markFailed on the way down. Never
  /// throws: every outcome is a state transition the queue can retry.
  Future<void> _deliverOne(DailyReport report, _Config cfg) async {
    final DailyReport? claimed;
    try {
      claimed = await firebase.claimReport(report.businessDate);
    } catch (err) {
      // permission-denied (claim not minted), offline transaction, or
      // a rules refusal — none of them are fixed by trying again now.
      _log.error('Claim failed for ${report.businessDate}: $err');
      return;
    }
    if (claimed == null) return; // another instance won, or backoff

    await _sendReport(claimed, cfg);
  }

  Future<void> _sendReport(DailyReport claimed, _Config cfg) async {
    _log.info('Telegram send started: ${claimed.businessDate}');
    try {
      final int messageId = await telegram.sendMessage(
        token: cfg.token,
        chatId: cfg.chatId,
        text: generateTelegramMessage(claimed),
      );
      await markSent(claimed.businessDate, messageId);
      configError.value = null;
    } on TelegramException catch (err) {
      if (err.isConfigError) configError.value = err.message;
      await markFailed(claimed.businessDate, err.message);
    } catch (err) {
      await markFailed(claimed.businessDate, 'Unexpected error: $err');
    }
  }

  Future<void> markSent(String dateKey, int messageId) async {
    try {
      await firebase.markSent(dateKey, telegramMessageId: messageId);
      _log.info('Telegram send successful: $dateKey');
    } catch (err) {
      // The owner HAS the message; a failed status write leaves the doc
      // in `sending` and the stale-claim window re-delivers — the only
      // honest options are a rare duplicate or a lost record, and the
      // rules choose the record.
      _log.error('Could not record delivery for $dateKey: $err');
    }
  }

  Future<void> markFailed(String dateKey, String message) async {
    try {
      await firebase.markFailed(dateKey, lastError: message);
      _log.error('Telegram send failed: $dateKey — $message');
    } catch (err) {
      _log.error('Could not record failure for $dateKey (stale-claim recovery will retry): $err');
    }
    _scheduleRetry(null);
  }

  /// The next automatic attempt, when something in the queue is not yet
  /// eligible. Never sooner than the backoff, never longer than the
  /// 15-minute cap — listeners do the instant work, this only catches
  /// the backoff boundary.
  void _scheduleRetry(Duration? fixed) {
    _retryTimer?.cancel();
    Duration? soonest;
    if (fixed != null) soonest = fixed;
    for (final DailyReport r in _failed) {
      final DateTime? last = r.lastAttemptAt;
      if (last == null) continue;
      final Duration wait =
          DeliveryPolicy.backoff(r.attemptCount) - DateTime.now().toUtc().difference(last);
      if (wait > Duration.zero && (soonest == null || wait < soonest)) soonest = wait;
    }
    if (soonest == null) return;
    _retryTimer = Timer(soonest, processQueue);
  }

  Future<_Config?> _loadConfig() async {
    final String? token = await storage.readToken();
    final String? chatId = await storage.readChatId();
    if (token == null || token.isEmpty || chatId == null || chatId.isEmpty) {
      _log.error('Telegram is not configured yet — open the setup screen.');
      return null;
    }
    return _Config(token, chatId);
  }

  /// The owner's daily message, built ONLY from the numbers Leadger
  /// snapshotted (spec §16) — the bridge never derives a total.
  static String generateTelegramMessage(DailyReport r) {
    final ReportCounters c = r.counters;
    final StringBuffer b = StringBuffer();
    b
          ..writeln('📊 LEADGER DAILY CLOSING')
          ..writeln('━━━━━━━━━━━━━━━━━━━━')
          ..writeln()
          ..writeln('📅 ${formatReportDate(r)}')
          ..writeln('🕘 Closed: ${formatReportTime(r.closedAt)}')
          ..writeln()
          ..writeln('💰 SALES')
          ..writeln('• Transactions: ${c.txnCount}')
          ..writeln('• Total Sales: ${formatINR(c.grossPaise)}')
          ..writeln()
          ..writeln('💳 PAYMENTS')
          ..writeln('• Cash: ${formatINR(c.cashPaise)}')
          ..writeln('• UPI: ${formatINR(c.upiPaise)}')
          ..writeln('• Card: ${formatINR(c.cardPaise)}')
          ..writeln('• Due: ${formatINR(c.duePaise)}')
          ..writeln()
          ..writeln('💸 EXPENSES')
          ..writeln('• Expenses: ${formatINR(r.expensesPaise)}')
          ..writeln()
          ..writeln('📈 NET')
          ..writeln('• Net: ${formatINR(r.netPaise)}')
          ..writeln()
          ..writeln('🔒 SHOP CLOSED')
          ..writeln()
          ..writeln('━━━━━━━━━━━━━━━━━━━━')
          ..write('🤖 Leadger');
    return b.toString();
  }

  /// The setup screen's probe message (spec §22). Sends to Telegram
  /// only — it never reads or writes `dailyReports`, because a test
  /// must not be able to touch accounting data.
  static String buildTestMessage() =>
      '🧪 LEADGER TELEGRAM TEST\n\n'
      'Telegram integration is working correctly.\n\n'
      'Device:\nLeadger Office Bridge\n\n'
      'Time:\n${formatReportDateTime(null)}';

  /// [Send Test Message]: getMe + one message, then report the masked
  /// Chat ID the setup screen shows (`Owner: ••••1234`).
  Future<String> sendTestMessage() async {
    final _Config? cfg = await _loadConfig();
    if (cfg == null) {
      throw TelegramException(
        code: 'unauthorized',
        message: 'Telegram is not configured yet. Paste the bot token and Chat ID first.',
      );
    }
    await telegram.testConnection(cfg.token);
    await telegram.sendMessage(token: cfg.token, chatId: cfg.chatId, text: buildTestMessage());
    configError.value = null;
    _log.info('Test message delivered to ${SecureStorageService.maskChatId(cfg.chatId)}');
    return SecureStorageService.maskChatId(cfg.chatId);
  }

  /// [Test Telegram Connection] without sending anything: getMe only.
  Future<TelegramUser> testConnectionOnly() async {
    final _Config? cfg = await _loadConfig();
    if (cfg == null) {
      throw TelegramException(
        code: 'unauthorized',
        message: 'Telegram is not configured yet. Paste the bot token and Chat ID first.',
      );
    }
    return telegram.testConnection(cfg.token);
  }

  void close() => detach();
}

class _Config {
  const _Config(this.token, this.chatId);
  final String token;
  final String chatId;
}
