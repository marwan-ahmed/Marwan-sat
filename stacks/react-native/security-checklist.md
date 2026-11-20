## Stack-specific: React Native / Expo

- **Storage:** tokens in `expo-secure-store` / Keychain-Keystore wrappers, never in `AsyncStorage`, MMKV without encryption, or logs.
- **Bundle exposure:** the JS bundle (Hermes bytecode included) is extractable. `EXPO_PUBLIC_*` variables and anything in `app.json`/`app.config.*` `extra` ship with the app — no secrets there.
- **Network:** HTTPS only; no cleartext exceptions in `AndroidManifest.xml` / ATS without a documented reason.
- **Deep links:** validate every parameter; never perform privileged actions from a link without an authenticated session.
- **WebView:** restrict `originWhitelist`; do not expose `postMessage` handlers that perform privileged actions to untrusted content.
- **OTA updates:** when using over-the-air updates, rely on signed updates per the platform's mechanism; an update channel must not be writable by untrusted parties.
- **Platform:** minimal permissions in `app.json`/native manifests.
