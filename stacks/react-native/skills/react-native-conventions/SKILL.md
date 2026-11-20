---
name: sat-react-native-conventions
description: "Marwan SAT conventions for React Native / Expo apps in TypeScript: keeping business logic testable, money and dates, secure storage, and deterministic Jest tests. Follow the project's existing navigation, state and folder patterns first."
---

# React Native / Expo — SAT conventions

**Rule zero:** the project's existing patterns and `AGENTS.md` win over this file. Read neighbouring code before writing. No new dependencies.

## Structure
- Business rules and calculations in plain TypeScript modules, free of React and native APIs, so they are unit-testable.
- API clients and storage behind small modules that tests can replace at the boundary.

## Money and dates
- Money as integer minor units (or the decimal type the project already uses); never JS floats for arithmetic.
- Rounding method and position as SPEC states.
- Inject the clock or use Jest fake timers (`jest.useFakeTimers().setSystemTime(...)`); UTC unless SPEC says otherwise.

## Tests (test author and reviewer)
- Jest (and React Native Testing Library if the project has it). Names carry the id: `it('AC-3: …')`.
- Domain logic: pure unit tests with exact expected values. Components: behaviour named in SPEC, not snapshots alone.
- Mock only external boundaries (network, secure storage, native modules).
- Abuse cases at the app level: missing/expired token, tampered stored data, malicious deep-link parameters — assert refusal and no data leak.
