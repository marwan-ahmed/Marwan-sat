## Stack-specific: Laravel / PHP

- **Mass assignment:** every model sets `$fillable` (or a deliberate `$guarded`); controllers never pass `$request->all()` to `create`/`update` — use validated data from a FormRequest.
- **Authorization:** Policies/Gates checked in every controller action (`$this->authorize`, `Gate::authorize`, or `can` middleware). Route model binding is scoped to the tenant (global scope or `scopeBindings()`); never trust an id from the request alone.
- **Queries:** Eloquent/Query Builder bindings; `DB::raw`, `whereRaw`, `orderByRaw` only with bound parameters, never interpolated input.
- **Output:** Blade `{{ }}` escapes; `{!! !!}` only for trusted, sanitized HTML.
- **CSRF** protection active for web routes; APIs use Sanctum/tokens with abilities.
- **Configuration:** `APP_DEBUG=false` outside local; no secrets committed; error pages do not leak stack traces.
- **Money:** `decimal` casts or integer minor units; balance changes inside `DB::transaction(...)`, with `lockForUpdate()` where concurrent updates are possible.
- **Uploads:** validate `mimes`/`max`, store outside `public/` unless public by design, never use client file names as paths.
