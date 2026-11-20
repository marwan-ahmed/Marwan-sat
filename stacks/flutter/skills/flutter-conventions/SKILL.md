---
name: sat-flutter-conventions
description: "Marwan SAT conventions for Flutter / Dart apps: layering, money and dates, secure storage, and deterministic unit/widget tests with flutter_test. Follow the project's existing state-management and architecture first."
---

# Flutter / Dart — SAT conventions

**Rule zero:** the project's existing architecture (state management, folders, DI) and `AGENTS.md` win over this file. Read neighbouring code before writing. No new packages in `pubspec.yaml`.

## Structure
- Keep calculations and business rules in plain Dart classes (domain layer), free of widgets and platform code, so they are unit-testable.
- Network clients and storage behind interfaces so tests can replace them at the boundary.

## Money and dates
- Money as integer minor units (or the decimal type the project already uses). Never `double` for amounts.
- Rounding method and position as SPEC states.
- Inject the clock (a function or class returning `DateTime`) instead of calling `DateTime.now()` inside business logic; tests pass a fixed time. Use UTC unless SPEC says otherwise.

## Tests (test author and reviewer)
- `flutter_test`; names carry the id: `test('AC-3: …', …)` / `testWidgets('AC-4: …', …)`.
- Unit tests for domain logic with exact expected values; widget tests for UI behaviour named in SPEC.
- Mock only external boundaries (HTTP client, storage, platform channels) with the mocking library the project already has.
- Abuse cases at the app level: unauthenticated deep link, tampered local data, token absent/expired — assert the app refuses and does not leak data.
