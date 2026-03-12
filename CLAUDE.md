# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install              # Install dependencies
npm run dev              # Start dev server with auto-reload (nodemon)
npm start                # Start production server
npm run migrate          # Run database migrations
npm test                 # Run all tests with coverage
npm test -- --watch      # Watch mode
npm test -- tests/pushService.test.js  # Run single test file
```

## Architecture Overview

This is a Node.js/Express integration layer between internal workflows and DocuSign eSignature. The service handles document submission, webhook processing, data extraction, and downstream API integration.

### Request Flow

1. **Inbound**: Internal system → `/api/v1/envelopes` → DocuSign (create envelope)
2. **Webhook**: DocuSign → `/api/v1/webhook/docusign` → Extract data → Push to downstream API
3. **Dashboard**: `/dashboard` provides monitoring UI

### Core Components

| Layer | File | Responsibility |
|-------|------|----------------|
| Entry | `src/server.js` | Server bootstrap, graceful shutdown |
| App | `src/app.js` | Express factory, middleware chain, error handling |
| Config | `src/config/index.js` | Environment variable loading and validation |
| Routes | `src/routes/envelopes.js` | Envelope CRUD, document download, retry |
| Routes | `src/routes/webhook.js` | DocuSign Connect callback handler |
| Routes | `src/routes/dashboard.js` | Monitoring dashboard |
| Services | `src/services/docusignService.js` | DocuSign SDK wrapper (JWT auth, envelope ops) |
| Services | `src/services/extractorService.js` | Tab values → canonical data mapping |
| Services | `src/services/pushService.js` | Downstream API client with retry logic |
| Services | `src/services/alertService.js` | Email notifications via nodemailer |
| Middleware | `src/middleware/apiKeyAuth.js` | API key validation (`x-api-key` header) |
| Middleware | `src/middleware/hmacValidator.js` | DocuSign webhook HMAC-SHA256 validation |
| Database | `src/db/client.js` | PostgreSQL abstraction |
| Database | `src/db/supabase.js` | Supabase-specific client |

### Database Schema

Three tables in Supabase PostgreSQL:
- `envelopes` - Job tracking (job_id, envelope_id, status, payload)
- `events` - Event audit trail per envelope
- `errors` - Error logging for alerting

Migrations are in `src/db/migrations/*.sql`.

### Authentication

- **API endpoints**: Require `x-api-key` header matching `API_KEY` env var
- **Webhook endpoint**: HMAC-SHA256 signature validation via `X-DocuSign-Signature-1` header
- **Dashboard**: Uses `api_key` query parameter for browser access

### Key Patterns

- **Idempotency**: Submit endpoint supports `Idempotency-Key` header to prevent duplicates
- **Retry logic**: Downstream push retries 3 times with exponential backoff (1s, 5s, 15s)
- **Alert rate limiting**: Max 1 email per envelope ID per error type per 15 minutes
- **Async processing**: Webhook responds within 10s, heavy processing runs async

## Testing

Tests use Jest with nock for HTTP mocking and supertest for endpoint testing. Coverage target is 80% for functions/lines/statements.

Test files go in `tests/` directory with `.test.js` suffix.

## Environment Setup

Copy `.env.example` to `.env` and configure. Required external services:
- DocuSign Developer Account (sandbox) with RSA key at `certs/docusign.pem`
- Supabase PostgreSQL (connection string in `DATABASE_URL`)
- SMTP server for alerts
