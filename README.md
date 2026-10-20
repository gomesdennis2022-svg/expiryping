# ExpiryPing

Daily domain-registration and SSL-certificate expiry monitoring for freelancers and agencies, built entirely on free tiers.

- **Website and dashboard**: static files in `web/`, hosted on GitHub Pages.
- **Database and sign-in**: Supabase (Postgres with row-level security, magic-link email login).
- **Checker**: `checker/check.js`, run hourly by GitHub Actions. Each domain is checked about once a day (new ones within the hour). It reads the SSL certificate with a TLS handshake and the registration expiry from RDAP, emails alerts at 30, 14, 7, 3 and 1 days, and sends monthly reports on the 1st.
- **Email**: Resend.
- **Payments**: Lemon Squeezy, with a Supabase Edge Function (`supabase/functions/lemonsqueezy-webhook`) that sets the user's plan.

```
web/                      landing page, dashboard, legal pages
checker/lib.js            pure logic (alert thresholds, parsing, emails), shared with the dashboard
checker/net.js            RDAP and TLS lookups
checker/check.js          the scheduled job
supabase/migrations/      database schema and security rules
supabase/functions/       payment webhook
.github/workflows/        hourly check, website deploy, tests
```

## Plans

| Plan | Price | Domains | Extras |
| --- | --- | --- | --- |
| free | $0 | 5 | email alerts |
| freelancer | $9/mo or $90/yr | 75 | monthly client reports |
| lifetime | $79 once | 75 | same as freelancer |
| agency | $29/mo | 500 | reports under your own brand name |

Limits are enforced in the database (`enforce_domain_limit` trigger), so the browser can't bypass them.

## Already set up

- Supabase project `expiryping` (ref `arocheyyeqldpmeeihzv`, us-east-1) with the schema from `supabase/migrations/001_init.sql` applied and tested.
- The `lemonsqueezy-webhook` Edge Function is deployed at `https://arocheyyeqldpmeeihzv.supabase.co/functions/v1/lemonsqueezy-webhook`. It returns 500 until its secrets are set (step 4).
- `web/config.js` already points at the Supabase project.

## Setup steps

### 1. GitHub
1. Repo **Settings > Pages > Build and deployment > Source: GitHub Actions**.
2. Repo **Settings > Secrets and variables > Actions**:
   - Secrets: `SUPABASE_SERVICE_ROLE_KEY` (Supabase **Project Settings > API keys**, the `service_role` / secret key), `RESEND_API_KEY` (step 3).
   - Variables: `APP_URL` only if you move to a custom domain (defaults to `https://gomesdennis2022-svg.github.io/expiryping/app.html`); `MAIL_FROM` = `ExpiryPing <alerts@yourdomain.com>`. Optionally `DRY_RUN` = `1` to run checks without sending email.
3. Run **Actions > Deploy website** and **Actions > Check domains** once by hand to confirm they work.

The repo should be public so Actions minutes are unlimited. Keys live only in GitHub Secrets, never in the code.

### 2. Supabase sign-in
In **Authentication > URL Configuration**, set **Site URL** to your dashboard URL and add it under **Redirect URLs**.

Supabase's built-in email sender is limited to a few emails an hour. Before launch, set **Authentication > Emails > SMTP Settings** to Resend: host `smtp.resend.com`, port `465`, user `resend`, password = your Resend API key, sender = your `MAIL_FROM` address.

### 3. Resend (email)
1. Sign up at resend.com and create an API key with sending access.
2. Add your domain under **Domains** and create the DNS records it shows (SPF, DKIM). Until a domain is verified, Resend only delivers to your own address, which is fine for testing.

### 4. Lemon Squeezy (payments)
1. Create a store, then four products: Freelancer ($9/month, with a $90/year variant), Agency ($29/month), Lifetime ($79 one-time, limit 50 sales).
2. Note each variant's ID (shown on the product's variant settings or in the checkout URL).
3. **Settings > Webhooks > +**: URL `https://arocheyyeqldpmeeihzv.supabase.co/functions/v1/lemonsqueezy-webhook`, a signing secret you choose, events `order_created`, `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_expired`, `subscription_resumed`.
4. In Supabase **Edge Functions > Secrets**, add `LEMONSQUEEZY_WEBHOOK_SECRET` (the signing secret) and `LS_VARIANT_PLANS`, for example `{"111":"freelancer","112":"freelancer","222":"agency","333":"lifetime"}`.
5. Put each product's checkout link (**Share** button) into `web/config.js` under `checkout`. The dashboard adds the user's id and email to the link so the webhook can match the payment.
6. Test with Lemon Squeezy's test mode, then switch the store live.

## Development

```
npm test                 # unit tests, no network
DRY_RUN=1 SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run check
```

To preview the website locally: `cp -r web _site && cp checker/lib.js _site/ && npx serve _site`.
