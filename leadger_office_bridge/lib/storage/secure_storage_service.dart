/// Where the bot token lives.
///
/// The token exists in exactly ONE place: this phone's encrypted
/// storage (flutter_secure_storage → EncryptedSharedPreferences on
/// Android). It is never written to Firestore, never to plain
/// SharedPreferences, and never committed to the repository — the
/// bridge is the only component that ever talks to Telegram, so the
/// Leadger web app could not leak what it never holds.
library;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SecureStorageService {
  SecureStorageService({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  static const String _kTokenKey = 'telegram_bot_token';
  static const String _kChatIdKey = 'telegram_owner_chat_id';

  final FlutterSecureStorage _storage;

  Future<String?> readToken() => _storage.read(key: _kTokenKey);
  Future<String?> readChatId() => _storage.read(key: _kChatIdKey);

  Future<void> writeConfig({required String token, required String chatId}) async {
    await _storage.write(key: _kTokenKey, value: token.trim());
    await _storage.write(key: _kChatIdKey, value: chatId.trim());
  }

  Future<void> clear() async {
    await _storage.delete(key: _kTokenKey);
    await _storage.delete(key: _kChatIdKey);
  }

  /// `••••••1234` — a Chat ID is not a secret like the token is, but the
  /// setup screen still never echoes either value back in full.
  static String maskChatId(String chatId) {
    final String s = chatId.trim();
    if (s.length <= 4) return '•' * s.length;
    return '•' * (s.length - 4) + s.substring(s.length - 4);
  }

  /// `…AbCd` — enough to recognise a token, never enough to use one.
  static String maskToken(String token) {
    final String s = token.trim();
    if (s.length <= 8) return '•' * s.length;
    return '…${s.substring(s.length - 4)}';
  }
}
