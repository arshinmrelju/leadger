/// The bridge dashboard (spec §12, §25, §26): four status lights,
/// today's delivery card, the three actions, and the recent-report
/// history. Deliberately an office utility — not a second ledger.
library;

import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';

import '../background/bridge_service.dart';
import '../models/daily_report.dart';
import '../models/report_text.dart';
import '../services/firebase_service.dart';
import '../services/log_service.dart';
import '../services/report_delivery_service.dart';
import '../services/telegram_service.dart';
import 'settings_screen.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key, required this.onReset});
  final VoidCallback onReset;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  late final ReportDeliveryService _engine;
  StreamSubscription<List<ConnectivityResult>>? _connectivitySub;
  BridgeAccess? _access;
  bool _internet = false;
  bool _serviceRunning = false;
  String? _uid;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _engine = buildBridgeEngine();
    _engine.configError.addListener(_onChange);
    _bootstrap();
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  Future<void> _bootstrap() async {
    // Keep the service alive whenever configuration exists (§23).
    try {
      _serviceRunning = await isBridgeServiceRunning();
      if (!_serviceRunning) {
        await startBridgeService();
        _serviceRunning = await isBridgeServiceRunning();
      }
    } catch (err) {
      LogService.instance.error('Could not start foreground service: $err');
    }
    final List<ConnectivityResult> now = await Connectivity().checkConnectivity();
    _internet = now.contains(ConnectivityResult.wifi) ||
        now.contains(ConnectivityResult.mobile) ||
        now.contains(ConnectivityResult.ethernet) ||
        now.contains(ConnectivityResult.vpn);
    _connectivitySub = Connectivity().onConnectivityChanged.listen((results) {
      final bool up = results.contains(ConnectivityResult.wifi) ||
          results.contains(ConnectivityResult.mobile) ||
          results.contains(ConnectivityResult.ethernet) ||
          results.contains(ConnectivityResult.vpn);
      if (mounted && up != _internet) setState(() => _internet = up);
    });
    final BridgeAccess access = await _engine.checkNow();
    if (mounted) {
      setState(() {
        _access = access;
        _uid = _engine.firebase.currentUser?.uid;
        _serviceRunning = _serviceRunning;
      });
      // The Firestore listeners paint the cards; today's report and
      // the history below are fed by the engine's own streams.
    }
  }

  @override
  void dispose() {
    _connectivitySub?.cancel();
    _engine.configError.removeListener(_onChange);
    _engine.close();
    super.dispose();
  }

  Future<void> _checkNow() async {
    setState(() => _busy = true);
    final BridgeAccess access = await _engine.checkNow();
    if (mounted) {
      setState(() {
        _access = access;
        _uid = _engine.firebase.currentUser?.uid;
        _busy = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(access == BridgeAccess.ready
            ? 'Checked — queue swept.'
            : 'Firebase: ${access.name}. Will keep retrying automatically.'),
      ));
    }
  }

  Future<void> _sendTest() async {
    setState(() => _busy = true);
    try {
      final String owner = await _engine.sendTestMessage();
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('🧪 Test message sent — owner $owner')));
      }
    } on TelegramException catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err.message)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final String today = kolkataDateKey();
    return Scaffold(
      appBar: AppBar(
        title: const Text('LEADGER OFFICE BRIDGE'),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            tooltip: 'Telegram Settings',
            onPressed: () async {
              await Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const SettingsScreen()),
              );
              if (mounted) _bootstrap();
            },
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Divider(),
          _StatusRow('Telegram', _telegramState()),
          _StatusRow('Firebase', _firebaseState()),
          _StatusRow('Internet',
              _internet ? '🟢 Connected' : '🔴 Offline'),
          if (!_internet)
            const Padding(
              padding: EdgeInsets.only(left: 12, bottom: 8),
              child: Text(
                'Pending reports will be sent automatically when connection returns.',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
            ),
          _StatusRow('Bridge',
              _serviceRunning ? '🟢 Running (foreground service)' : '🔴 Not running'),
          if (_access == BridgeAccess.missingClaim) ...[
            Padding(
              padding: const EdgeInsets.only(left: 12, bottom: 8),
              child: Text(
                'Authorise this phone:\n'
                'node tools/set-bridge-claim.mjs --key sa.json --uid ${_uid ?? '<uid>'}\n'
                'then tap Check Now.',
                style: TextStyle(fontSize: 12, color: Colors.orange.shade900),
              ),
            ),
          ],
          const Divider(),
          Text("Today's Report", style: Theme.of(context).textTheme.titleMedium),
          StreamBuilder<DailyReport?>(
            stream: _engine.firebase.watchReport(today),
            builder: (context, snap) => _todayCard(context, snap.data),
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: FilledButton(onPressed: _busy ? null : _sendTest, child: const Text('Send Test Message'))),
            const SizedBox(width: 8),
            Expanded(child: OutlinedButton(onPressed: _busy ? null : _checkNow, child: const Text('Check Now'))),
          ]),
          const SizedBox(height: 20),
          Text('Recent Reports', style: Theme.of(context).textTheme.titleMedium),
          StreamBuilder<List<DailyReport>>(
            stream: _engine.firebase.watchRecent(10),
            builder: (context, snap) {
              final List<DailyReport> rows = snap.data ?? const <DailyReport>[];
              if (rows.isEmpty) {
                return const Padding(
                  padding: EdgeInsets.all(12),
                  child: Text('No reports yet — they appear here once a day is closed in Leadger.'),
                );
              }
              return Column(children: rows.map(_historyRow).toList());
            },
          ),
          const SizedBox(height: 24),
          if (_uid != null)
            Text('Bridge UID: $_uid', style: const TextStyle(fontSize: 11, color: Colors.black45)),
        ],
      ),
    );
  }

  String _telegramState() {
    final String? err = _engine.configError.value;
    if (err != null) return '🔴 $err';
    return '🟢 Configured';
  }

  String _firebaseState() {
    switch (_access) {
      case BridgeAccess.ready:
        return '🟢 Connected';
      case BridgeAccess.missingClaim:
        return '🟠 Awaiting bridge claim';
      case BridgeAccess.offline:
        return '🔴 Offline';
      case BridgeAccess.error:
        return '🔴 Error — see logs';
      case null:
        return '⚪ Checking…';
    }
  }

  Widget _todayCard(BuildContext context, DailyReport? report) {
    if (report == null) {
      return const Card(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Text('No report queued for today yet. It is created automatically when the day is closed in Leadger.'),
        ),
      );
    }
    final String statusLine;
    switch (report.status) {
      case ReportStatus.sent:
        statusLine = '🟢 Sent — ${formatReportTime(report.sentAt)}';
      case ReportStatus.pending:
        statusLine = '⏳ Queued — waiting for the bridge';
      case ReportStatus.sending:
        statusLine = '📤 Sending now…';
      case ReportStatus.failed:
        statusLine = '🔴 Failed — ${report.lastError ?? 'unknown error'}';
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(formatReportDate(report), style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 4),
          Text('Status:\n$statusLine', style: const TextStyle(fontSize: 14)),
        ]),
      ),
    );
  }

  Widget _historyRow(DailyReport r) {
    final String line;
    switch (r.status) {
      case ReportStatus.sent:
        line = '🟢 Sent — ${formatReportTime(r.sentAt)}';
      case ReportStatus.failed:
        line = '🔴 Failed — Retry available';
      case ReportStatus.pending:
        line = '⏳ Queued';
      case ReportStatus.sending:
        line = '📤 Sending…';
    }
    return ListTile(
      dense: true,
      leading: const Icon(Icons.receipt_long),
      title: Text(formatReportDate(r)),
      subtitle: Text(line),
    );
  }
}

class _StatusRow extends StatelessWidget {
  const _StatusRow(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 12),
        child: Row(children: [
          SizedBox(width: 90, child: Text(label, style: const TextStyle(fontWeight: FontWeight.w600))),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13))),
        ]),
      );
}
