/// The bridge's ONLY Firebase surface: anonymous sign-in, the claim
/// probe, listeners over `dailyReports`, and the claim/markSent/
/// markFailed writes that move a report through its state machine.
///
/// Deliberately narrow: nothing here can read a sale, write a counter,
/// or touch a grant — firestore.rules denies the bridge everything
/// except this one collection, and this service never even constructs
/// a path to anything else.
library;

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';

import '../firebase_options.dart';
import '../models/daily_report.dart';
import '../models/delivery_policy.dart';
import 'log_service.dart';

/// What the dashboard shows for Firebase: not just "signed in" but
/// "signed in AND the bridge claim is on the token AND Firestore
/// answers".
enum BridgeAccess {
  /// Signed in, claim present, Firestore reachable.
  ready,

  /// Signed in, but Firestore refuses: the claim has not been minted
  /// yet (tools/set-bridge-claim.mjs) or was cleared.
  missingClaim,

  /// No internet / Firestore unreachable (offline is normal — reports
  /// wait for us).
  offline,

  /// Anonymous sign-in itself failed (provider disabled?).
  error,
}

class FirebaseService {
  FirebaseService();

  static const String _collection = 'dailyReports';

  FirebaseFirestore get _db => FirebaseFirestore.instance;

  bool _online = false;
  void Function(bool)? onOnlineChanged;

  bool get online => _online;
  User? get currentUser => FirebaseAuth.instance.currentUser;

  Future<void> initialize() async {
    if (Firebase.apps.isEmpty) {
      await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
      LogService.instance.info('Firebase initialized');
    }
  }

  /// Anonymous sign-in — no allowlist entry, no accessGrant, no money
  /// access. The bridge's identity is the claim, nothing else.
  Future<User?> signIn() async {
    await initialize();
    final User? existing = FirebaseAuth.instance.currentUser;
    if (existing != null) return existing;
    final UserCredential cred = await FirebaseAuth.instance.signInAnonymously();
    LogService.instance.info('Signed in anonymously as ${cred.user?.uid ?? '?'}');
    return cred.user;
  }

  /// Sign in and PROVE the claim works by reading our own collection.
  /// A permission-denied on `dailyReports` means the claim is missing
  /// — the only honest way to detect it, since rules refuse the read.
  Future<BridgeAccess> ensureAccess() async {
    try {
      final User? user = await signIn();
      if (user == null) return BridgeAccess.error;
      // Claims only appear on a freshly issued token; force one so a
      // just-minted claim is visible without waiting an hour.
      final IdTokenResult token = await user.getIdTokenResult(true);
      final bool claimed = token.claims?['bridge'] == true;
      if (!claimed) {
        LogService.instance.error('Bridge claim missing on this device\'s token — run tools/set-bridge-claim.mjs with this UID');
        return BridgeAccess.missingClaim;
      }
      await _db.collection(_collection).limit(1).get(const GetOptions(source: Source.server));
      _setOnline(true);
      LogService.instance.info('Firebase connected (bridge claim verified)');
      return BridgeAccess.ready;
    } on FirebaseException catch (err) {
      if (err.code == 'permission-denied') {
        LogService.instance.error('Firestore denied the report read — bridge claim missing or rules not deployed');
        return BridgeAccess.missingClaim;
      }
      if (err.code == 'unavailable' || err.code == 'deadline-exceeded') {
        LogService.instance.info('Firebase unreachable (offline)');
        return BridgeAccess.offline;
      }
      LogService.instance.error('Firebase error: ${err.code} ${err.message ?? ''}');
      return BridgeAccess.error;
    } catch (err) {
      LogService.instance.error('Firebase sign-in failed: $err');
      return BridgeAccess.error;
    }
  }

  void _setOnline(bool value) {
    if (_online != value) {
      _online = value;
      onOnlineChanged?.call(value);
    }
  }

  /// One report, live — the dashboard's "today" card.
  Stream<DailyReport?> watchReport(String dateKey) => _db
      .collection(_collection)
      .doc(dateKey)
      .snapshots(includeMetadataChanges: true)
      .map((DocumentSnapshot<Object?> snap) {
        _setOnline(!snap.metadata.isFromCache || snap.metadata.hasPendingWrites);
        return snap.exists ? DailyReport.fromMap(snap.id, snap.data()! as Map<String, dynamic>) : null;
      });

  /// The bridge's work queue: every report in one status, live. Three
  /// equality queries (pending / sending / failed) replace polling —
  /// Firestore tells us the moment anything changes (spec §13).
  Stream<List<DailyReport>> watchByStatus(ReportStatus status) => _db
      .collection(_collection)
      .where('status', isEqualTo: status.name)
      .snapshots(includeMetadataChanges: true)
      .map((QuerySnapshot<Object?> snap) {
        _setOnline(!snap.metadata.isFromCache || snap.metadata.hasPendingWrites);
        return snap.docs
            .map((d) => DailyReport.fromMap(d.id, d.data() as Map<String, dynamic>))
            .toList();
      });

  /// Delivery history for the dashboard (spec §26). Newest first.
  Stream<List<DailyReport>> watchRecent(int limit) => _db
      .collection(_collection)
      .orderBy('businessDate', descending: true)
      .limit(limit)
      .snapshots(includeMetadataChanges: true)
      .map((QuerySnapshot<Object?> snap) {
        _setOnline(!snap.metadata.isFromCache || snap.metadata.hasPendingWrites);
        return snap.docs
            .map((d) => DailyReport.fromMap(d.id, d.data() as Map<String, dynamic>))
            .toList();
      });

  /// Atomically claim a report for delivery (spec §15). The transaction
  /// re-reads the document server-side, so two bridges racing for the
  /// same report cannot both win — and firestore.rules independently
  /// refuses any transition the winner could not legally make. Returns
  /// the claimed report, or null when it is not eligible (already
  /// sent, being sent, or inside its backoff window).
  Future<DailyReport?> claimReport(String dateKey) async {
    final DocumentReference<Object?> ref = _db.collection(_collection).doc(dateKey);
    return _db.runTransaction<DailyReport?>((Transaction tx) async {
      final DocumentSnapshot<Object?> snap = await tx.get(ref);
      if (!snap.exists) return null;
      final DailyReport report =
          DailyReport.fromMap(snap.id, snap.data()! as Map<String, dynamic>);
      if (!DeliveryPolicy.eligibleForClaim(report, DateTime.now().toUtc())) {
        return null;
      }
      tx.update(ref, <String, Object?>{
        'status': ReportStatus.sending.name,
        'sendingAt': FieldValue.serverTimestamp(),
        'lastAttemptAt': FieldValue.serverTimestamp(),
        'attemptCount': report.attemptCount + 1,
        // A previous failure's text must not ride into a later `sent`.
        'lastError': FieldValue.delete(),
      });
      LogService.instance.info('Report claimed: $dateKey (attempt ${report.attemptCount + 1})');
      return DailyReport.fromMap(dateKey, <String, dynamic>{
        'businessDate': report.businessDate,
        'status': ReportStatus.sending.name,
        'reportVersion': report.reportVersion,
        'createdAt': report.createdAt,
        'closedAt': report.closedAt,
        'createdBy': report.createdBy,
        'counters': <String, dynamic>{
          'txnCount': report.counters.txnCount,
          'grossPaise': report.counters.grossPaise,
          'cashPaise': report.counters.cashPaise,
          'upiPaise': report.counters.upiPaise,
          'cardPaise': report.counters.cardPaise,
          'duePaise': report.counters.duePaise,
          'collectedPaise': report.counters.collectedPaise,
        },
        'expensesPaise': report.expensesPaise,
        'netPaise': report.netPaise,
        'attemptCount': report.attemptCount + 1,
        'sendingAt': DateTime.now().toUtc(),
        'lastAttemptAt': DateTime.now().toUtc(),
      });
    });
  }

  /// Telegram accepted the message: the report becomes terminal.
  Future<void> markSent(String dateKey, {required int telegramMessageId}) async {
    await _db.collection(_collection).doc(dateKey).update(<String, Object?>{
      'status': ReportStatus.sent.name,
      'sentAt': FieldValue.serverTimestamp(),
      'telegramMessageId': telegramMessageId,
    });
    LogService.instance.info('Report marked sent: $dateKey (tg#$telegramMessageId)');
  }

  /// Telegram refused or unreachable: the report stays in the queue as
  /// `failed` and the backoff policy decides when it is tried again.
  Future<void> markFailed(String dateKey, {required String lastError}) async {
    final String bounded =
        lastError.length <= 300 ? lastError : lastError.substring(0, 300);
    await _db.collection(_collection).doc(dateKey).update(<String, Object?>{
      'status': ReportStatus.failed.name,
      'lastError': bounded,
    });
    LogService.instance.error('Report marked failed: $dateKey — $bounded');
  }
}
