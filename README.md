# ANTHEON API — Backend

The real, deployable backend for ANTHEON. This is what the front-end
(`index.html`) should eventually call instead of reading/writing
`localStorage` — same identity model, same RBAC, same product-module and
subscription framework, now enforced server-side.

## What's implemented

- **Auth**: signup, login, refresh tokens, logout, forgot/reset password,
  email-verification token issuance. Passwords hashed with bcrypt
  (server-side, unlike the prototype's client-side hash). First account
  created becomes Founder, same as the front-end prototype.
- **RBAC**: `requireAuth` + `requireRole()` middleware enforced on every
  sensitive route — not just hidden in the UI.
- **Users**: profile self-service, founder/admin user management.
- **Products**: full CRUD for product modules, gated to founder/admin.
- **Plans**: full CRUD for subscription plans, gated to founder.
- **Payments**: real Stripe Checkout session creation + webhook handler
  that activates a plan on successful payment. Card data never touches
  this server.
- **Notifications**: personal + broadcast.
- **Audit log + analytics**: append-only log of sensitive actions, plus a
  summary endpoint for the founder dashboard.
- **Platform settings**: founder-controlled toggles (signups enabled,
  maintenance mode, etc).

## What you still have to do yourself

This code will not run against real users until you:

1. **Provision a Postgres database** (e.g. Supabase, Neon, RDS, or a
   self-hosted instance) and run `db/schema.sql` against it.
2. **Create a Stripe account**, switch on test mode, create Products/
   Prices there, and paste the resulting `price_...` IDs into each plan's
   `stripe_price_id` column. Add your Stripe secret key and webhook
   signing secret to `.env`.
3. **Pick and wire a real email provider** (Postmark, SES, Resend,
   SendGrid...) — fill in `src/lib/email.js` with real API calls. Until
   you do, emails are only logged to the server console.
4. **Generate real secrets** for `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`
   (`openssl rand -hex 32`) and store them in a real secrets manager in
   production, not a committed `.env` file.
5. **Deploy it somewhere** (Render, Fly.io, Railway, AWS ECS...) with
   separate environments for development / staging / production, matching
   the spec's environment-management requirement.
6. **Point the front-end at it** — replace the `localStorage` read/write
   calls in `index.html` with `fetch()` calls to these endpoints, and swap
   the `sessionStorage` session token for the `accessToken`/`refreshToken`
   pair these auth routes return.

None of this requires touching the route/schema structure — it's designed
to absorb exactly these changes without a rewrite.

## Local setup

```bash
cp .env.example .env         # then fill in real values
npm install
npm run migrate              # applies db/schema.sql to DATABASE_URL
npm run dev                  # starts the API on :4000 with auto-reload
```

## API surface

| Method | Path | Access |
|---|---|---|
| POST | `/auth/signup` | public |
| POST | `/auth/login` | public |
| POST | `/auth/refresh` | public (valid refresh token) |
| POST | `/auth/logout` | authenticated |
| POST | `/auth/forgot-password` | public |
| POST | `/auth/reset-password` | public (valid reset token) |
| GET | `/users/me` | authenticated |
| PATCH | `/users/me` | authenticated |
| GET | `/users` | founder, admin |
| PATCH | `/users/:id` | founder, admin (role changes: founder only) |
| GET | `/products` | authenticated (customers see published only) |
| POST/PATCH/DELETE | `/products/:id` | founder, admin |
| GET | `/plans` | authenticated |
| POST/PATCH/DELETE | `/plans/:id` | founder |
| POST | `/plans/:id/subscribe` | authenticated (free plans / manual grants) |
| GET | `/payments` | authenticated (own history, or all for founder/admin) |
| POST | `/payments/checkout-session` | authenticated |
| POST | `/payments/webhook` | Stripe only (signature-verified) |
| GET | `/notifications` | authenticated |
| POST | `/notifications/broadcast` | founder |
| GET | `/audit` | founder, admin |
| GET | `/audit/analytics` | founder, admin |
| GET/PATCH | `/platform/settings` | read: public, write: founder |

## Security notes

- Every route that returns user data selects an explicit safe column list
  — `password_hash` is never serialized to a client.
- Rate limiting is applied globally and more tightly on `/auth/*`.
- `helmet()` sets standard security headers; CORS is restricted to the
  origins you list in `CORS_ORIGINS`.
- Row-level security is enabled on `payments` and `notifications` in the
  schema as a second layer of defense — author actual policies once the
  app connects as a non-superuser database role (see PostgreSQL RLS docs).
- This still needs, before real launch: a security review, dependency
  audit (`npm audit`), and — given this handles financial data — likely a
  third-party penetration test.
