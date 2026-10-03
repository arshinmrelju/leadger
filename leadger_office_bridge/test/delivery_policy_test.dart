// When the bridge may (re)claim a report: the rules are the enforcer,
// but the client policy decides what it even attempts.

import 'package:flutter_test/flutter_test.dart';
import 'package:leadger_office_bridge/models/daily_report.dart';
import 'package:leadger_office_bridge/models/delivery_policy.dart';

DailyReport report(ReportStatus status, {int attempts = 0, DateTime? lastAttemptAt, DateTime? sendingAt}) =>
    DailyReport(
      businessDate: '2026-10-03',
      status: status,
      reportVersion: 1,
      createdBy: 'u1',
      counters: const ReportCounters(
        txnCount: 1, grossPaise: 100, cashPaise: 100, upiPaise: 0,
        cardPaise: 0, duePaise: 0, collectedPaise: 100,
      ),
      expensesPaise: 0,
      netPaise: 100,
      attemptCount: attempts,
      lastAttemptAt: lastAttemptAt,
      sendingAt: sendingAt,
    );

void main() {
  final DateTime now = DateTime.utc(2026, 10, 3, 15, 0);

  test('pending is always eligible (a fresh close ships at once)', () {
    expect(DeliveryPolicy.eligibleForClaim(report(ReportStatus.pending), now), isTrue);
  });

  test('sent is terminal — never eligible, never re-sent', () {
    expect(DeliveryPolicy.eligibleForClaim(report(ReportStatus.sent, attempts: 1), now), isFalse);
  });

  group('failed backoff', () {
    test('exponential: 30s, 1m, 2m, 4m … capped at 15m', () {
      expect(DeliveryPolicy.backoff(1), const Duration(seconds: 30));
      expect(DeliveryPolicy.backoff(2), const Duration(minutes: 1));
      expect(DeliveryPolicy.backoff(3), const Duration(minutes: 2));
      expect(DeliveryPolicy.backoff(4), const Duration(minutes: 4));
      expect(DeliveryPolicy.backoff(10), const Duration(minutes: 15));
    });
    test('inside the window: wait', () {
      final DailyReport r = report(ReportStatus.failed, attempts: 2,
          lastAttemptAt: now.subtract(const Duration(seconds: 10)));
      expect(DeliveryPolicy.eligibleForClaim(r, now), isFalse);
    });
    test('past the window: retry', () {
      final DailyReport r = report(ReportStatus.failed, attempts: 2,
          lastAttemptAt: now.subtract(const Duration(minutes: 1)));
      expect(DeliveryPolicy.eligibleForClaim(r, now), isTrue);
    });
  });

  group('stale sending recovery', () {
    test('fresh sending: do not touch (another instance is working)', () {
      final DailyReport r = report(ReportStatus.sending,
          attempts: 1, sendingAt: now.subtract(const Duration(minutes: 1)));
      expect(DeliveryPolicy.eligibleForClaim(r, now), isFalse);
    });
    test('stale sending: reclaim after the safety window', () {
      final DailyReport r = report(ReportStatus.sending,
          attempts: 1, sendingAt: now.subtract(const Duration(minutes: 4)));
      expect(DeliveryPolicy.eligibleForClaim(r, now), isTrue);
    });
    test('client window is wider than the rules window (clock skew margin)', () {
      expect(DeliveryPolicy.clientStaleSending, greaterThan(DeliveryPolicy.rulesStaleSending));
    });
  });
}
