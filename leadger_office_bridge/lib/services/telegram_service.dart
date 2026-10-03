/// The ONE place the bridge talks to Telegram (spec §17).
///
/// Every Bot API call goes through here: a single JSON POST per method,
/// Telegram's `{ok, result|error_code,description}` envelope parsed
/// into either a value or a structured [TelegramException] that says
/// whether trying again could possibly help. No other file may build a
/// Bot API URL — and no message this class produces ever contains the
/// token, because the token only ever lives inside the URL path, which
/// is never put into an error, a log line or an exception.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

/// Why a Telegram call failed, and whether a retry can succeed.
class TelegramException implements Exception {
  TelegramException({
    required this.code,
    required this.message,
    this.retryable = false,
    this.statusCode,
  });

  /// `network` | `unauthorized` | `badChat` | `badRequest` |
  /// `rateLimited` | `server` | `timeout`
  final String code;
  final String message;
  final bool retryable;
  final int? statusCode;

  /// Configuration problems the owner must fix by hand: an invalid bot
  /// token or a wrong Chat ID (spec §28).
  bool get isConfigError => code == 'unauthorized' || code == 'badChat';

  @override
  String toString() => message;
}

class TelegramUser {
  const TelegramUser({required this.id, this.username, this.firstName});
  final int id;
  final String? username;
  final String? firstName;
}

class TelegramService {
  TelegramService({http.Client? client}) : _client = client ?? http.Client();

  static const String _base = 'https://api.telegram.org';
  static const Duration _timeout = Duration(seconds: 20);

  final http.Client _client;

  /// Low-level call. `token` is used ONLY to build the request URL and
  /// is never echoed into exceptions.
  Future<Map<String, dynamic>> _call(
    String token,
    String method,
    Map<String, dynamic> body,
  ) async {
    if (token.trim().isEmpty) {
      throw TelegramException(
        code: 'unauthorized',
        message: 'No bot token configured. Open Telegram Settings and paste the token from BotFather.',
      );
    }
    final Uri uri = Uri.parse('$_base/bot${token.trim()}/$method');
    http.Response res;
    try {
      res = await _client
          .post(uri, headers: {'content-type': 'application/json'}, body: jsonEncode(body))
          .timeout(_timeout);
    } on TimeoutException {
      throw TelegramException(code: 'timeout', message: 'Telegram did not answer in time.', retryable: true);
    } on SocketException {
      throw TelegramException(code: 'network', message: 'No internet connection.', retryable: true);
    } on http.ClientException {
      throw TelegramException(code: 'network', message: 'Could not reach Telegram.', retryable: true);
    }

    Map<String, dynamic> json;
    try {
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      if (decoded is! Map<String, dynamic>) throw const FormatException();
      json = decoded;
    } on FormatException {
      throw TelegramException(
        code: 'server',
        message: 'Telegram sent an unreadable response (HTTP ${res.statusCode}).',
        retryable: res.statusCode >= 500,
        statusCode: res.statusCode,
      );
    }

    if (json['ok'] == true && json['result'] is Map<String, dynamic>) {
      return json['result'] as Map<String, dynamic>;
    }
    throw _classify(json, res.statusCode);
  }

  TelegramException _classify(Map<String, dynamic> json, int status) {
    final int? errCode = (json['error_code'] as num?)?.toInt();
    final String desc = (json['description'] as String?) ?? 'Telegram refused the request.';
    final String lower = desc.toLowerCase();

    if (errCode == 401 || lower.contains('unauthorized')) {
      return TelegramException(
        code: 'unauthorized',
        message: 'The bot token was rejected by Telegram. Check it in Telegram Settings.',
        statusCode: errCode,
      );
    }
    if (lower.contains('chat not found') || lower.contains('chat_id') || lower.contains('peer_id_invalid')) {
      return TelegramException(
        code: 'badChat',
        message: 'Telegram does not know this chat. Start a conversation with the bot and check the Chat ID.',
        statusCode: errCode,
      );
    }
    if (errCode == 429) {
      final dynamic ra = json['parameters'];
      final int? retryAfter = ra is Map ? (ra['retry_after'] as num?)?.toInt() : null;
      return TelegramException(
        code: 'rateLimited',
        message: 'Telegram is rate-limiting us${retryAfter != null ? ' (retry in ${retryAfter}s)' : ''}.',
        retryable: true,
        statusCode: errCode,
      );
    }
    if (errCode != null && errCode >= 500) {
      return TelegramException(code: 'server', message: 'Telegram is having a problem ($errCode).', retryable: true, statusCode: errCode);
    }
    return TelegramException(code: 'badRequest', message: 'Telegram refused the message: $desc', statusCode: errCode);
  }

  /// `getMe` — is the token real?
  Future<TelegramUser> testConnection(String token) async {
    final Map<String, dynamic> result = await _call(token, 'getMe', <String, dynamic>{});
    final int id = (result['id'] as num?)?.toInt() ?? 0;
    if (id <= 0) {
      throw TelegramException(code: 'badRequest', message: 'Telegram returned no bot identity.');
    }
    return TelegramUser(
      id: id,
      username: result['username'] as String?,
      firstName: result['first_name'] as String?,
    );
  }

  /// `sendMessage` — returns Telegram's message id on success.
  Future<int> sendMessage({
    required String token,
    required String chatId,
    required String text,
  }) async {
    if (chatId.trim().isEmpty) {
      throw TelegramException(
        code: 'badChat',
        message: 'No owner Chat ID configured. Open Telegram Settings.',
      );
    }
    final Map<String, dynamic> result = await _call(token, 'sendMessage', <String, dynamic>{
      'chat_id': chatId.trim(),
      'text': text,
    });
    final int messageId = (result['message_id'] as num?)?.toInt() ?? 0;
    if (messageId <= 0) {
      throw TelegramException(code: 'server', message: 'Telegram accepted the message but gave no id.', retryable: true);
    }
    return messageId;
  }
}
