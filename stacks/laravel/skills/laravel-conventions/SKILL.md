---
name: sat-laravel-conventions
description: "Marwan SAT conventions for Laravel / PHP projects: controllers, FormRequests, Policies, Eloquent, money handling, and deterministic feature/unit tests with Pest or PHPUnit. Follow the project's existing patterns first."
---

# Laravel / PHP — SAT conventions

**Rule zero:** the project's existing patterns and `AGENTS.md` win over this file. Read neighbouring code before writing. No new Composer packages.

## Where things live
- Entry points: `routes/web.php`, `routes/api.php` → controllers in `app/Http/Controllers`.
- Validation: FormRequest classes in `app/Http/Requests` (`rules()` + `authorize()`).
- Authorization: Policies in `app/Policies`, registered per the project's Laravel version.
- Domain logic: services/actions classes, free of HTTP concerns, so they are unit-testable.
- Schema: migrations in `database/migrations` — reversible (`down()` implemented).

## Money and dates
- `decimal:2` (or the scale in SPEC) casts, or integer minor units. Never floats.
- Rounding method and position as SPEC states.
- Dates with Carbon; fixed time in tests (`Carbon::setTestNow(...)` or `$this->travelTo(...)`).
- Balance changes inside `DB::transaction(...)`; `lockForUpdate()` when concurrent writes are possible.

## Tests (test author and reviewer)
- Use the project's runner (Pest or PHPUnit). Test names carry the id: `it('AC-3: …')` or `test_ac_3_…`.
- Feature tests: `actingAs($user)` for each role; `RefreshDatabase` (or the project's equivalent) on the test database only.
- Abuse cases: create two tenants and two roles; assert `assertForbidden()` / `assertNotFound()` and `assertJsonMissing([...])` for the other tenant's data.
- Factories with synthetic data; no production dumps.
