/// Pure text formatting for the report — no Firebase, no HTTP, so every
/// character the owner sees is unit-testable, including parity with the
/// web app's own formatters.
library;

import 'daily_report.dart';

const List<String> _months = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/// Asia/Kolkata is a fixed +05:30 with no DST, so an offset constant is
/// the whole timezone.
const Duration kolkataOffset = Duration(hours: 5, minutes: 30);

DateTime toKolkata(DateTime? utc) =>
    (utc ?? DateTime.now()).toUtc().add(kolkataOffset);

/// Format integer paise exactly like Leadger's `formatINR` (utils.js):
/// Indian digit grouping, the subunit only when it is non-zero, and the
/// sign INSIDE after the symbol (`₹-5`), which is what `"₹" + Intl`
/// produces on the web side. Kept byte-identical so a number can never
/// differ between the ledger and the Telegram message.
String formatINR(int paise) {
  final bool negative = paise < 0;
  final int abs = paise.abs();
  final String grouped = _groupIndian((abs ~/ 100).toString());
  final int sub = abs % 100;
  final String frac = sub == 0 ? '' : '.${sub.toString().padLeft(2, '0')}';
  return '₹${negative ? '-' : ''}$grouped$frac';
}

/// Right-to-left: the last three digits, then twos — `100000` -> `1,00,000`.
String _groupIndian(String digits) {
  if (digits.length <= 3) return digits;
  final String last3 = digits.substring(digits.length - 3);
  String rest = digits.substring(0, digits.length - 3);
  final List<String> parts = <String>[];
  while (rest.length > 2) {
    parts.insert(0, rest.substring(rest.length - 2));
    rest = rest.substring(0, rest.length - 2);
  }
  if (rest.isNotEmpty) parts.insert(0, rest);
  return '${parts.join(',')},$last3';
}

/// `03 Oct 2026` — the business date, in Kolkata time.
String formatReportDate(DailyReport report) {
  final DateTime d = toKolkata(report.closedAt ?? report.createdAt);
  return '${d.day.toString().padLeft(2, '0')} ${_months[d.month - 1]} ${d.year}';
}

/// `8:42 PM` — the closing/sent time, in Kolkata time.
String formatReportTime(DateTime? utc) {
  final DateTime d = toKolkata(utc);
  final int h12 = d.hour % 12 == 0 ? 12 : d.hour % 12;
  final String mm = d.minute.toString().padLeft(2, '0');
  return '$h12:$mm ${d.hour < 12 ? 'AM' : 'PM'}';
}

/// `03 Oct 2026, 8:20 PM` — the stamp the test message carries.
String formatReportDateTime(DateTime? utc) {
  final DateTime d = toKolkata(utc);
  return '${d.day.toString().padLeft(2, '0')} ${_months[d.month - 1]} ${d.year}, '
      '${formatReportTime(utc)}';
}

/// Today's business date as the `YYYY-MM-DD` key Leadger uses.
String kolkataDateKey([DateTime? utc]) {
  final DateTime d = toKolkata(utc);
  return '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';
}
