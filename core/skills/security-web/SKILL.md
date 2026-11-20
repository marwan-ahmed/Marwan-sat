---
name: sat-security-web
description: "Marwan SAT web security checklist for threat modelling and auditing web apps and APIs: the 7 attack axes mapped to OWASP Top 10:2025, ASVS 5.0 and the API Security Top 10, with what to test and what counts as proof."
---

# Marwan SAT — web security profile

References: OWASP Top 10:2025 · OWASP ASVS 5.0 · OWASP API Security Top 10. Use the project constitution too when `security.constitution` is set.

## Axis ids (use exactly these in SECURITY_AUDIT.json)
`access_control` · `authentication` · `injection` · `business_logic` · `mass_assignment_data_exposure` · `resource_abuse_uploads` · `configuration_secrets_supply_chain`

## 1. access_control — tenant isolation and authorization (OWASP A01:2025)
- Every read/write is scoped by the tenant and user taken from the **server session**, never from the URL, body, query or headers.
- Try: another tenant's id in the path; a lower role calling an admin action; changing `tenant_id`/`owner_id` in the body; listing endpoints without filters; IDs enumerated sequentially.
- Proof: request + response showing data of another tenant, or a privileged action succeeding with a lower role.

## 2. authentication — sessions and tokens
- Every server entry point requires authentication unless SPEC says it is public.
- Cookies: `HttpOnly`, `Secure`, `SameSite`. Token expiry and revocation. CSRF protection for cookie-based state changes. Brute-force protection on login/OTP.
- Try: calling the endpoint without a session, with an expired one, with another user's token; repeated login attempts.

## 3. injection — input handling
- Schema validation of every input (types, ranges, lengths, enums). Parameterised queries only; no string-built SQL. Output encoding for HTML. No user input in shell commands, file paths or outbound URLs (SSRF).
- Try: SQL metacharacters, script payloads, path traversal (`../`), internal URLs (`http://127.0.0.1`, cloud metadata addresses) — against localhost only.

## 4. business_logic — money and state
- Double submission and concurrent requests on balance-changing actions (send the same request in parallel); idempotency keys where required; multi-step money changes in one transaction; negative, zero, huge and fractional amounts; state transitions out of order.
- Proof: two parallel requests producing a double effect, or an amount/state outcome contradicting SPEC.

## 5. mass_assignment_data_exposure
- Extra fields in requests (`role`, `status`, `approved`, `tenant_id`, `balance`) must be ignored or rejected.
- Responses must not contain internal fields, password hashes, tokens or other tenants' data. Logs must not contain secrets or full personal data. Errors must not leak stack traces or SQL (OWASP A10:2025 — mishandling of exceptional conditions).

## 6. resource_abuse_uploads
- Rate limits on login, OTP, password reset, payment and expensive endpoints (check with ≤ 50 requests).
- Uploads: type allow-list by content, size limits, storage outside the web root, no path traversal in file names.

## 7. configuration_secrets_supply_chain
- No secrets in code, in client bundles or in public env vars (for example `NEXT_PUBLIC_*` in Next.js is shipped to the browser).
- Security headers (CSP, HSTS, X-Content-Type-Options, frame-ancestors). Debug modes off.
- Dependency vulnerabilities from the scanner output (OWASP A03:2025 — software supply chain failures).

## What is not proof
- "The code looks like it checks permissions" → `REVIEWED_STATIC`, not `TESTED_DYNAMIC`.
- A scanner warning you did not verify → triage it; it is not a confirmed finding by itself.
- "No vulnerability found" → `CLEAR_WITHIN_SCOPE` for what was tested; never "safe".
