## Stack-specific: Flutter / Dart

- **Storage:** tokens and personal data in `flutter_secure_storage` (or the project's keystore wrapper), never in `shared_preferences`, plain files or logs (`print`/`debugPrint` of tokens is a finding).
- **Network:** HTTPS only; `android:usesCleartextTraffic` absent or false; no `badCertificateCallback` returning `true`; no ATS exceptions without a documented reason.
- **Secrets in the bundle:** API keys and secrets in Dart code, `--dart-define` values and assets are extractable from the app. Anything secret belongs on the server.
- **Deep links / app links:** validate every parameter; a link never triggers a privileged action without an authenticated session.
- **Platform:** minimal permissions in `AndroidManifest.xml` and `Info.plist`; exported activities only when needed.
- **WebView:** no JavaScript channels exposed to untrusted pages.
- **Release builds:** consider `--obfuscate --split-debug-info` when the threat model calls for resilience; it is not a substitute for server-side controls.
