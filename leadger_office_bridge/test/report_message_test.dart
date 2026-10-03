// The exact bytes the owner receives (spec §16). This layout is a
// contract: the web app writes the numbers, this message only spells
// them, and the test pins every line so a formatting refactor can
// never silently change the daily report.

import 'package:flutter_test/flutter_test.dart';
import 'package:leadger_office_bridge/models/daily_report.dart';
import 'package:leadger_office_bridge/services/report_delivery_service.dart';

DailyReport _sample() => DailyReport(
      businessDate: '2026-10-03',
      status: ReportStatus.sent,
      reportVersion: 1,
      createdBy: 'owner@example.com',
      counters: const ReportCounters(
        txnCount: 12,
        grossPaise: 1000000, // ₹10,000
        cashPaise: 500000, // ₹5,000
        upiPaise: 400000, // ₹4,000
        cardPaise: 100000, // ₹1,000
        duePaise: 0,
        collectedPaise: 1000000,
      ),
      expensesPaise: 12345, // ₹123.45
      netPaise: 987655, // ₹9,876.55
      attemptCount: 1,
      // 15:12 UTC = 20:42 IST on 03 Oct 2026.
      closedAt: DateTime.utc(2026, 10, 3, 15, 12),
      createdAt: DateTime.utc(2026, 10, 3, 15, 12),
      sentAt: DateTime.utc(2026, 10, 3, 15, 12),
      telegramMessageId: 42,
    );

void main() {
  group('generateTelegramMessage (spec §16 layout)', () {
    test('renders the closing report byte-for-byte', () {
      const String expected = '📊 LEADGER DAILY CLOSING\n'
          '━━━━━━━━━━━━━━━━━━━━\n'
          '\n'
          '📅 03 Oct 2026\n'
          '🕘 Closed: 8:42 PM\n'
          '\n'
          '💰 SALES\n'
          '• Transactions: 12\n'
          '• Total Sales: ₹10,000\n'
          '\n'
          '💳 PAYMENTS\n'
          '• Cash: ₹5,000\n'
          '• UPI: ₹4,000\n'
          '• Card: ₹1,000\n'
          '• Due: ₹0\n'
          '\n'
          '💸 EXPENSES\n'
          '• Expenses: ₹123.45\n'
          '\n'
          '📈 NET\n'
          '• Net: ₹9,876.55\n'
          '\n'
          '🔒 SHOP CLOSED\n'
          '\n'
          '━━━━━━━━━━━━━━━━━━━━\n'
          '🤖 Leadger';
      expect(
        ReportDeliveryService.generateTelegramMessage(_sample()),
        expected,
      );
    });

    test('net equals collected minus expenses as the rules enforce', () {
      final DailyReport r = _sample();
      expect(
        r.netPaise,
        r.counters.collectedPaise - r.expensesPaise,
      );
    });

    test('no trailing newline after the signature', () {
      final String text = ReportDeliveryService.generateTelegramMessage(_sample());
      expect(text.endsWith('🤖 Leadger'), isTrue);
      expect(text.endsWith('\n'), isFalse);
    });

    test('a negative net keeps the sign inside the rupee (₹-5 style)', () {
      final DailyReport r = _sample();
      final DailyReport loss = DailyReport(
        businessDate: r.businessDate,
        status: r.status,
        reportVersion: r.reportVersion,
        createdBy: r.createdBy,
        counters: const ReportCounters(
          txnCount: 1,
          grossPaise: 10000,
          cashPaise: 0,
          upiPaise: 0,
          cardPaise: 0,
          duePaise: 0,
          collectedPaise: 10000,
        ),
        expensesPaise: 10500, // expenses exceed collections
        netPaise: -500,
        attemptCount: 1,
        closedAt: r.closedAt,
      );
      expect(
        ReportDeliveryService.generateTelegramMessage(loss),
        contains('• Net: ₹-5'),
      );
    });
  });
}
