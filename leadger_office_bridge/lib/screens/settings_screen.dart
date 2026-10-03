/// Telegram settings + device care (spec §12, §24, §27): edit the
/// configuration without ever echoing the token back, re-test it, see
/// the bridge's own logs, and take the battery steps Android requires
/// of a bridge that must survive the night.
library;

import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import '../background/bridge_service.dart';
import '../services/log_service.dart';
import '../services/telegram_service.dart';
import '../storage/secure_storage_service.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final SecureStorageService _storage = SecureStorageService();
  final TextEditingController _token = TextEditingController();
  final TextEditingController _chatId = TextEditingController();
  bool _busy = false;
  String? _status;

  void _onLogChanged() {
    if (mounted) setState(() {});
  }

  @override
  void initState() {
    super.initState();
    _load();
    LogService.instance.entries.addListener(_onLogChanged);
  }

  Future<void> _load() async {
    // Only the MASK is shown: the stored token never leaves secure
    // storage, so a shoulder in the office reads dots.
    final String? token = await _storage.readToken();
    final String? chatId = await _storage.readChatId();
    if (mounted) {
      setState(() {
        if (chatId != null && chatId.isNotEmpty) _chatId.text = chatId;
        if (token != null && token.isNotEmpty) {
          _token.text = SecureStorageService.maskToken(token);
        }
      });
    }
  }

  @override
  void dispose() {
    LogService.instance.entries.removeListener(_onLogChanged);
    _token.dispose();
    _chatId.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() { _busy = true; _status = null; });
    try {
      final String chatId = _chatId.text.trim();
      // A masked value is NOT a token: if the field still holds the
      // dots, the stored token stands as it is.
      final String typed = _token.text.trim();
      final bool tokenUntouched = typed.isEmpty || typed.startsWith('…') || typed.startsWith('•');
      final String? existing = tokenUntouched ? await _storage.readToken() : null;
      if (existing == null && typed.isEmpty) {
        throw TelegramException(code: 'unauthorized', message: 'Paste the bot token.');
      }
      if (chatId.isEmpty) {
        throw TelegramException(code: 'badChat', message: 'The owner Chat ID is needed.');
      }
      await _storage.writeConfig(token: existing ?? typed, chatId: chatId);
      await FlutterForegroundTask.updateService(
        notificationTitle: 'Leadger Bridge',
        notificationText: 'Telegram reporting active',
      );
      setState(() => _status = '🟢 Saved.');
    } on TelegramException catch (err) {
      setState(() => _status = err.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _test() async {
    setState(() { _busy = true; _status = null; });
    try {
      // Test what is SAVED (or about to be), never the masked dots.
      final String saved = await _storage.readToken() ?? '';
      final String typed = _token.text.trim();
      final String token =
          typed.isNotEmpty && !typed.startsWith('…') && !typed.startsWith('•') ? typed : saved;
      final TelegramUser user = await TelegramService().testConnection(token);
      setState(() => _status = '🟢 Telegram Connected — @${user.username ?? user.id}');
    } on TelegramException catch (err) {
      setState(() => _status = err.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _requestBatteryExemption() async {
    // Deliberate, user-initiated, and explained — never silent (§24).
    try {
      if (!await FlutterForegroundTask.isIgnoringBatteryOptimizations) {
        await FlutterForegroundTask.requestIgnoreBatteryOptimization();
      } else {
        setState(() => _status = 'Battery optimization is already disabled for this app.');
      }
    } catch (err) {
      setState(() => _status = 'Could not open the battery dialog: $err');
    }
  }

  @override
  Widget build(BuildContext context) {
    final List<BridgeLogEntry> logs = LogService.instance.entries.value;
    return Scaffold(
      appBar: AppBar(title: const Text('Telegram Settings')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextField(
            controller: _token,
            obscureText: true,
            decoration: const InputDecoration(
              labelText: 'Bot Token',
              hintText: 'Leave as dots to keep the saved token',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _chatId,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Owner Chat ID',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          Row(children: [
            Expanded(child: OutlinedButton(onPressed: _busy ? null : _test, child: const Text('Test Connection'))),
            const SizedBox(width: 8),
            Expanded(child: FilledButton(onPressed: _busy ? null : _save, child: const Text('Save'))),
          ]),
          if (_status != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_status!, style: const TextStyle(fontSize: 13)),
            ),
          const Divider(height: 36),
          Text('Reliability (Android)', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          const Text(
            'For reliable automatic reports:\n'
            '1. Keep the phone connected to Wi-Fi/mobile data.\n'
            '2. Disable battery optimization for Leadger Office Bridge.\n'
            '3. Allow background activity.\n'
            '4. Allow notifications.\n'
            '5. Allow auto-start if the device manufacturer requires it.',
            style: TextStyle(fontSize: 13),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            icon: const Icon(Icons.battery_saver),
            label: const Text('Disable battery optimization'),
            onPressed: _requestBatteryExemption,
          ),
          const Divider(height: 36),
          Row(children: [
            Expanded(child: Text('Bridge service', style: Theme.of(context).textTheme.titleMedium)),
            TextButton(
              onPressed: () async {
                final bool running = await isBridgeServiceRunning();
                if (running) {
                  await stopBridgeService();
                } else {
                  await startBridgeService();
                }
                if (mounted) setState(() {});
              },
              child: const Text('Stop / Start'),
            ),
          ]),
          const Divider(height: 36),
          Text('Logs', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          if (logs.isEmpty) const Text('Nothing yet.', style: TextStyle(fontSize: 13)),
          ...logs.take(50).map((BridgeLogEntry e) => Text(
                '${e.stamp}  ${e.message}',
                style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
              )),
          const SizedBox(height: 24),
          const Text(
            'The bot token is stored only in this phone\'s encrypted storage. '
            'It is never written to Firebase and never shown in full.',
            style: TextStyle(fontSize: 12, color: Colors.black45),
          ),
        ],
      ),
    );
  }
}
