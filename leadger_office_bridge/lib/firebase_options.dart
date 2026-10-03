/// Firebase configuration for the office bridge.
///
/// The values are PUBLIC client configuration (the same ones the web
/// app ships in js/firebase.js) — no secret lives here, and certainly
/// no bot token. One value must be filled in before first run, see
/// README → Telegram Integration:
///
///   appId — the ANDROID app's id. Register the app once in the
///   Firebase console (Add app → Android, package com.leadger.leadger_office_bridge),
///   download its google-services.json into android/app/, and paste
///   the `mobilesdk_app_id` here.
library;

import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart' show kIsWeb;

class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      throw UnsupportedError('The office bridge runs on Android only.');
    }
    return android;
  }

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyD8IOVbktIMNhuziVf40WqhRMpp3pNu04w',
    appId: 'REPLACE_WITH_ANDROID_APP_ID', // from google-services.json
    messagingSenderId: '35151713005',
    projectId: 'trustxplpy',
    storageBucket: 'trustxplpy.firebasestorage.app',
  );
}
