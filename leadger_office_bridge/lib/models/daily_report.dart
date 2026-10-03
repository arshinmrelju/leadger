/// The daily closing report: the `dailyReports/{businessDate}` document
/// Leadger writes when a day is closed, and the office bridge ships to
/// Telegram.
///
/// The bridge is a TRANSPORT, never an accountant: everything here is a
/// faithful parse of the document firestore.rules validated against the
/// closed day head. Money is integer paise, exactly as in Leadger.
library;

import 'package:cloud_firestore/cloud_firestore.dart';

/// Per-method day totals, snapshotted from `dayHeads/{dateKey}.counters`.
class ReportCounters {
  const ReportCounters({
    required this.txnCount,
    required this.grossPaise,
    required this.cashPaise,
    required this.upiPaise,
    required this.cardPaise,
    required this.duePaise,
    required this.collectedPaise,
  });

  final int txnCount;
  final int grossPaise;
  final int cashPaise;
  final int upiPaise;
  final int cardPaise;
  final int duePaise;
  final int collectedPaise;

  factory ReportCounters.fromMap(Map<String, dynamic> map) => ReportCounters(
        txnCount: (map['txnCount'] as num?)?.toInt() ?? 0,
        grossPaise: (map['grossPaise'] as num?)?.toInt() ?? 0,
        cashPaise: (map['cashPaise'] as num?)?.toInt() ?? 0,
        upiPaise: (map['upiPaise'] as num?)?.toInt() ?? 0,
        cardPaise: (map['cardPaise'] as num?)?.toInt() ?? 0,
        duePaise: (map['duePaise'] as num?)?.toInt() ?? 0,
        collectedPaise: (map['collectedPaise'] as num?)?.toInt() ?? 0,
      );
}

/// The delivery state machine, mirroring firestore.rules exactly:
/// pending → sending → sent (terminal) | failed, with the bridge
/// re-claiming `failed` and a stale `sending` older than two minutes.
enum ReportStatus {
  pending,
  sending,
  sent,
  failed;

  static ReportStatus parse(String? raw) => ReportStatus.values.firstWhere(
        (s) => s.name == raw,
        orElse: () => ReportStatus.pending,
      );
}

class DailyReport {
  const DailyReport({
    required this.businessDate,
    required this.status,
    required this.reportVersion,
    required this.createdBy,
    required this.counters,
    required this.expensesPaise,
    required this.netPaise,
    required this.attemptCount,
    this.createdAt,
    this.closedAt,
    this.sendingAt,
    this.lastAttemptAt,
    this.sentAt,
    this.telegramMessageId,
    this.lastError,
  });

  final String businessDate;
  final ReportStatus status;
  final int reportVersion;
  final String createdBy;
  final ReportCounters counters;
  final int expensesPaise;
  final int netPaise;
  final int attemptCount;
  final DateTime? createdAt;
  final DateTime? closedAt;
  final DateTime? sendingAt;
  final DateTime? lastAttemptAt;
  final DateTime? sentAt;
  final int? telegramMessageId;
  final String? lastError;

  DateTime? get effectiveTime => sentAt ?? lastAttemptAt ?? sendingAt;

  /// Parse one Firestore document. Unknown/missing delivery fields are
  /// null, exactly as the rules' presence matrix allows them to be.
  factory DailyReport.fromMap(String docId, Map<String, dynamic> map) {
    final rawCounters = map['counters'];
    return DailyReport(
      businessDate: (map['businessDate'] as String?) ?? docId,
      status: ReportStatus.parse(map['status'] as String?),
      reportVersion: (map['reportVersion'] as num?)?.toInt() ?? 1,
      createdAt: _dateTime(map['createdAt']),
      closedAt: _dateTime(map['closedAt']),
      createdBy: (map['createdBy'] as String?) ?? '',
      counters: ReportCounters.fromMap(
        rawCounters is Map ? Map<String, dynamic>.from(rawCounters) : const {},
      ),
      expensesPaise: (map['expensesPaise'] as num?)?.toInt() ?? 0,
      netPaise: (map['netPaise'] as num?)?.toInt() ?? 0,
      attemptCount: (map['attemptCount'] as num?)?.toInt() ?? 0,
      sendingAt: _dateTime(map['sendingAt']),
      lastAttemptAt: _dateTime(map['lastAttemptAt']),
      sentAt: _dateTime(map['sentAt']),
      telegramMessageId: (map['telegramMessageId'] as num?)?.toInt(),
      lastError: map['lastError'] as String?,
    );
  }

  static DateTime? _dateTime(Object? value) {
    if (value is Timestamp) return value.toDate();
    if (value is DateTime) return value;
    return null;
  }
}
