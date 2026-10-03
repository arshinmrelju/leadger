/// When a report may be (re)claimed — the bridge's retry brain, pure
/// and unit-tested (spec §14, §15).
///
/// Two clocks matter: the CLIENT refuses a retry until the backoff has
/// passed, and firestore.rules independently refuses any claim on a
/// `sending` state younger than two minutes. The client window here is
/// deliberately LONGER (three minutes) than the rules' two: rules are
/// the source of truth, and a safety margin means a skewed phone clock
/// produces a quiet skip instead of a denial the log would have to
/// explain.
library;

import 'daily_report.dart';

class DeliveryPolicy {
  DeliveryPolicy._();

  /// What the rules enforce: a `sending` state older than this may be
  /// re-claimed (crashed phone recovery).
  static const Duration rulesStaleSending = Duration(minutes: 2);

  /// What the CLIENT waits before re-claiming — rules + clock margin.
  static const Duration clientStaleSending = Duration(minutes: 3);

  /// Exponential backoff after a failure: 30s, 1m, 2m, 4m, 8m, capped
  /// at 15 minutes. Never a hot loop, never a give-up (spec §28:
  /// "Telegram unavailable → retry later", forever).
  static Duration backoff(int attemptCount) {
    if (attemptCount < 1) return Duration.zero;
    int shift = attemptCount - 1;
    if (shift > 6) shift = 6;
    final int seconds = 30 * (1 << shift);
    return Duration(seconds: seconds > 900 ? 900 : seconds);
  }

  /// Should the bridge claim this report right now?
  static bool eligibleForClaim(DailyReport report, DateTime nowUtc) {
    switch (report.status) {
      case ReportStatus.pending:
        // A fresh close is sent immediately; rules re-check the head.
        return true;
      case ReportStatus.failed:
        final DateTime? last = report.lastAttemptAt;
        if (last == null) return true;
        return nowUtc.difference(last) >= backoff(report.attemptCount);
      case ReportStatus.sending:
        final DateTime? since = report.sendingAt;
        if (since == null) return true;
        return nowUtc.difference(since) > clientStaleSending;
      case ReportStatus.sent:
        return false; // terminal — never sent twice (spec §15)
    }
  }
}
