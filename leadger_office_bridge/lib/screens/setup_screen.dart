/// First-run setup (spec §10): paste the BotFather token and the
/// owner's Chat ID, prove the connection works, save into encrypted
/// storage — then the device's bridge UID is shown with the one
/// command that authorises it in firestore.rules, and the battery
/// checklist that keeps the phone actually running (spec §24).
library;

import 'package:flutter/material.dart';

import '../services/log_service.dart';
import '../services/telegram_service.dart';
import '../storage/secure_storage_service.dart';

class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.onSaved});
  final VoidCallback onSaved;

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final SecureStorageService _storage = SecureStorageService();
  final TextEditingController _token = TextEditingController();
  final TextEditingController _chatId = TextEditingController();

  bool _busy = false;
  String? _status; // last test outcome, shown under the button
  bool _connected = false;
  String? _maskedOwner;

  @override
  void dispose() {
    _token.dispose();
    _chatId.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() { _busy = true; _status = null; _connected = false; });
    try {
      await action();
    } on TelegramException catch (err) {
      setState(() => _status = err.message);
    } catch (err) {
      setState(() => _status = 'Unexpected error: $err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// [Test Telegram Connection]: getMe only — proves the token, no
  /// message sent, nothing written anywhere.
  Future<void> _test() => _run(() async {
        final TelegramService telegram = TelegramService();
        final String token = _token.text.trim();
        if (token.isEmpty) {
          throw TelegramException(code: 'unauthorized', message: 'Paste the bot token first.');
        }
        final TelegramUser user = await telegram.testConnection(token);
        setState(() {
          _connected = true;
          _status = '🟢 Telegram Connected — @${user.username ?? user.id}';
          _maskedOwner = _chatId.text.trim().isEmpty
              ? null
              : SecureStorageService.maskChatId(_chatId.text);
        });
      });

  /// [Save Configuration]: encrypted storage, then hand off. The token
  /// is never echoed back, never logged, never synced anywhere.
  Future<void> _save() => _run(() async {
        final String token = _token.text.trim();
        final String chatId = _chatId.text.trim();
        if (token.isEmpty || chatId.isEmpty) {
          throw TelegramException(code: 'badChat', message: 'Both the bot token and the owner Chat ID are needed.');
        }
        final TelegramService telegram = TelegramService();
        final TelegramUser user = await telegram.testConnection(token);
        await _storage.writeConfig(token: token, chatId: chatId);
        LogService.instance.info('Configuration saved (bot @${user.username ?? user.id}, owner ${SecureStorageService.maskChatId(chatId)})');
        if (mounted) widget.onSaved();
      });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('LEADGER OFFICE BRIDGE')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text('Telegram Configuration', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 16),
          TextField(
            controller: _token,
            obscureText: true,
            decoration: const InputDecoration(
              labelText: 'Bot Token',
              hintText: '123456789:AA… from BotFather',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _chatId,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Owner Chat ID',
              hintText: '-100… or a numeric id',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          Row(children: [
            Expanded(
              child: OutButton('Test Telegram Connection', _test, _busy),
            ),
          ]),
          const SizedBox(height: 8),
          if (_status != null)
            Text(_status!, style: TextStyle(color: _connected ? Colors.green.shade700 : Colors.red.shade700)),
          if (_connected && _maskedOwner != null) ...[
            const SizedBox(height: 4),
            Text('Owner: $_maskedOwner'),
          ],
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _busy ? null : _save,
            child: const Text('Save Configuration'),
          ),
          const Divider(height: 40),
          Text('For reliable automatic reports', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          const _Bullet('Keep the phone connected to Wi-Fi/mobile data.'),
          const _Bullet('Disable battery optimization for Leadger Office Bridge.'),
          const _Bullet('Allow background activity.'),
          const _Bullet('Allow notifications.'),
          const _Bullet('Allow auto-start if the device manufacturer requires it.'),
          const SizedBox(height: 12),
          const Text(
            'After saving, the dashboard shows this phone\'s bridge UID. '
            'Authorise it once from the computer that manages Leadger:\n\n'
            'node tools/set-bridge-claim.mjs --key sa.json --uid <that-uid>\n\n'
            'then tap Check Now on the dashboard.',
            style: TextStyle(fontSize: 13),
          ),
        ],
      ),
    );
  }
}

class OutButton extends StatelessWidget {
  const OutButton(this.label, this.onPressed, this.busy, {super.key});
  final String label;
  final Future<void> Function() onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) => OutlinedButton(
        onPressed: busy ? null : () => onPressed(),
        child: Text(label),
      );
}

class _Bullet extends StatelessWidget {
  const _Bullet(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('• '),
          Expanded(child: Text(text)),
        ]),
      );
}
