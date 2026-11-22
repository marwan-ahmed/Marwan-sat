---
name: sat-security-mobile
description: "Marwan SAT mobile security checklist for threat modelling and auditing Flutter and React Native apps along the 8 OWASP MASVS v2.1 categories; backend APIs are audited with the web profile."
---

# Marwan SAT — mobile security profile

Reference: OWASP MASVS v2.1 (8 categories). The backend the app talks to is audited with the **web** profile when it is in the task's scope and runs locally. In this SAT version the app binary itself is reviewed **statically**; dynamic testing on devices/emulators is out of scope, so mark it `REVIEWED_STATIC` or `NOT_TESTED` honestly.

## Axis ids (use exactly these in SECURITY_AUDIT.json)
`storage` · `crypto` · `auth` · `network` · `platform` · `code` · `resilience` · `privacy`

## storage (MASVS-STORAGE)
- Tokens and personal data only in the platform keystore/keychain (`flutter_secure_storage`, `expo-secure-store`, Keychain/Keystore) — never in SharedPreferences/AsyncStorage/plain files/logs.
- No sensitive data in screenshots/app switcher previews where the task requires it; no sensitive data in crash logs.

## crypto (MASVS-CRYPTO)
- No home-made crypto, no hard-coded keys, no ECB, no static IVs. Randomness from secure APIs.

## auth (MASVS-AUTH)
- Client side: biometric/PIN gates bound to keystore keys when used; logout clears tokens. Server-side authorization is checked with the web profile — the client is never trusted.

## network (MASVS-NETWORK)
- TLS everywhere; no cleartext traffic allowances (`usesCleartextTraffic`, ATS exceptions) unless justified; certificate validation never disabled; pinning when the threat model calls for it.

## platform (MASVS-PLATFORM)
- Minimal permissions in `AndroidManifest.xml` / `Info.plist`; exported components and deep links validate their input and do not trigger privileged actions without authentication; WebViews do not expose native bridges to untrusted content.

## code (MASVS-CODE)
- No secrets or API keys in the bundle (Dart/JS sources, `app.json`, `.env` shipped with the app); dependency vulnerabilities from the scanner output; input from deep links, QR codes and push payloads is validated.

## resilience (MASVS-RESILIENCE)
- Only when the threat model requires it (e.g. high-value financial apps): obfuscation, root/jailbreak signals, tamper checks. Never a substitute for server-side controls.

## privacy (MASVS-PRIVACY)
- Data minimisation; clear purpose for every permission; no personal data to analytics/third parties beyond what the task specifies.

## Project audit — controls that should exist (audit task, findings/security.json)
In a project audit, also report what is **absent** as `missing_control` findings: tokens kept outside the platform keystore; no certificate validation policy; exported components or deep links without verification; debug flags or verbose logging in release builds; no root/jailbreak or tamper response where the threat model needs one; personal data collected without a stated purpose. The backend the app calls is audited with the `web` axes when it is in scope.

## What is not proof
Reading the code is `REVIEWED_STATIC`. A finding is `confirmed` only with a reproduction (a failing test, a command and its output, or a request/response against the local backend).
