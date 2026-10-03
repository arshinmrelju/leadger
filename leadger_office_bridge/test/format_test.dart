// formatINR must be BYTE-IDENTICAL to Leadger's web formatter — the
// numbers in the Telegram message and the numbers in the ledger are
// the same numbers, spelled the same way. These vectors were produced
// by running the real js/utils.js formatINR().

import 'package:flutter_test/flutter_test.dart';
import 'package:leadger_office_bridge/models/report_text.dart';

void main() {
  group('formatINR parity with utils.js formatINR', () {
    const Map<int, String> vectors = <int, String>{
      0: '₹0',
      1: '₹0.01',
      5: '₹0.05',
      10: '₹0.10',
      50: '₹0.50',
      99: '₹0.99',
      100: '₹1',
      105: '₹1.05',
      500: '₹5',
      1050: '₹10.50',
      9999: '₹99.99',
      10000: '₹100',
      12345: '₹123.45',
      100000: '₹1,000',
      1000000: '₹10,000',
      1234567: '₹12,345.67',
      10000000: '₹1,00,000',
      123456789: '₹12,34,567.89',
      -500: '₹-5',
      -12345: '₹-123.45',
      -100000: '₹-1,000',
    };
    vectors.forEach((int paise, String expected) {
      test('$paise -> $expected', () {
        expect(formatINR(paise), expected);
      });
    });
  });

  group('Kolkata time', () {
    test('closing time renders as h:mm PM in +05:30', () {
      // 15:12 UTC = 20:42 IST
      expect(formatReportTime(DateTime.utc(2026, 10, 3, 15, 12)), '8:42 PM');
    });
    test('midnight renders as 12 AM', () {
      expect(formatReportTime(DateTime.utc(2026, 10, 3, 18, 30)), '12:00 AM');
    });
    test('noon renders as 12 PM', () {
      expect(formatReportTime(DateTime.utc(2026, 10, 3, 6, 30)), '12:00 PM');
    });
    test('business date key follows Kolkata, not the device', () {
      // 2026-10-03T20:00 UTC is already 2026-10-04 in Kolkata.
      expect(kolkataDateKey(DateTime.utc(2026, 10, 3, 20, 0)), '2026-10-04');
      expect(kolkataDateKey(DateTime.utc(2026, 10, 3, 12, 0)), '2026-10-03');
    });
    test('date stamp for the test message', () {
      expect(formatReportDateTime(DateTime.utc(2026, 10, 3, 14, 50)), '03 Oct 2026, 8:20 PM');
    });
  });
}
