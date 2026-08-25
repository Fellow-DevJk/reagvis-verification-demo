# Reagvis Verification Web Demo

Static, web-only demo for the provider-agnostic verification platform.

It shows three views:

- Applicant flow: DigiLocker, Aadhaar e-KYC, and manual-upload rails.
- Client dashboard: customer-facing verification summary and provider health.
- Reagvis console: operator review queue and audit trail.

The app currently points at the isolated demo API:

```text
https://rijbyw9mdd.execute-api.ap-south-1.amazonaws.com
```

This backend is demo-only. It uses mock providers, DynamoDB demo tables, simulated webhook delivery rows, and no real provider credentials.

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
