## Stack-specific: Next.js + TypeScript

- **Server Actions are public HTTP endpoints.** Every `"use server"` function authenticates and authorizes inside itself; never rely on the page that renders the form.
- **Route handlers** (`app/api/**/route.ts`) check the session and the tenant on every method.
- **Middleware is not authorization.** It may redirect, but data access must still be checked in the handler/action/data layer.
- **Client exposure:** anything prefixed `NEXT_PUBLIC_` ends up in the browser bundle. Props passed from Server Components to Client Components are serialized to the client — pass only the fields the UI needs.
- **Caching:** cached data (`fetch` cache, `unstable_cache`, route segment caching) must never be shared across tenants or users; the cache key includes the tenant/user when the data is scoped.
- **Drizzle / SQL:** the `sql` tagged template parameterizes values; `sql.raw()` and string concatenation do not. Multi-step money writes use `db.transaction(...)`.
- **Validation:** parse every input (form data, JSON, search params, route params) with a schema before use.
- **Images / fetch to user-supplied URLs:** restrict hosts to avoid SSRF.
