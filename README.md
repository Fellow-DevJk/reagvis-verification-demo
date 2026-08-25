# Reagvis Verification Web Demo

Static, web-only demo for the provider-agnostic verification platform.

It shows these views:

- Applicant flow: DigiLocker, Aadhaar e-KYC, and manual-upload rails.
- Overview: customer-facing summary, lifecycle counts, provider health, and recent sessions.
- Live trace: request-to-result path across API, engine, adapter, provider, normalizer, and webhook.
- Providers: provider registry/configuration readiness.
- Verifications: clickable session list with status filters.
- Webhooks: simulated customer delivery log.
- Sandbox: deterministic scenario launcher.
- Audit log: audit-event timeline.
- Review queue: internal/manual review queue with persisted approve/reject decisions.

The app currently points at the isolated demo API:

```text
https://rijbyw9mdd.execute-api.ap-south-1.amazonaws.com
```

This backend is demo-only. It uses mock providers, DynamoDB demo tables, simulated webhook delivery rows, and no real provider credentials.

## Presenting It

1. Click `Seed clean storyline` before a walkthrough.
2. Start in `Applicant flow` and run either a clean provider success or a manual-upload review scenario.
3. Open `Overview` to show the customer-facing dashboard.
4. Click any verification row to open the detail drawer.
5. Use `Open trace` from the drawer, or go to `Live trace`, to show the provider-adapter journey.
6. Use `Providers`, `Webhooks`, `Audit log`, and `Review queue` for deeper product walkthroughs.
7. Approve or reject a review case to show the queue, audit trail, webhook log, and dashboards updating from the backend.
8. Use `Reset tenant data` when the public demo gets noisy.

## Run Locally

```bash
cd demo/verification-web
python3 -m http.server 8080
```

Open:

```text
http://localhost:8080
```

## Override The API

Set this before `app.js` if a future deployment produces a different endpoint:

```html
<script>
  window.REAGVIS_DEMO_API_BASE = "https://example.execute-api.ap-south-1.amazonaws.com";
</script>
```

## GitHub Pages

This folder is intentionally plain static HTML/CSS/JS. It can be served from GitHub Pages from a dedicated repo, or copied into a `docs/` publishing folder if that is how the account repo is configured.

For now, keep the frontend separate from the managed KYC pilot environments. The API it calls is the isolated verification demo stack, not `kyc-dev` or `kyc-docgpu-dev`.
