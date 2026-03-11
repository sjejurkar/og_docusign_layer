# DocuSign Integration Layer — Software Requirements Specification

**Version:** 1.0  
**Status:** Draft  
**Target Stack:** Node.js / Express  
**Auth Model:** API Key  
**DocuSign Environment:** Sandbox / Demo  
**Downstream Target:** REST API (External System)  
**Error Handling:** Error Log + Email Notification  
**UI:** Simple Status / Monitoring Dashboard  

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements](#3-functional-requirements)
4. [API Contract](#4-api-contract)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Environment Variables](#6-environment-variables)
7. [Data Model](#7-data-model)
8. [Suggested Project Structure](#8-suggested-project-structure)
9. [Recommended npm Dependencies](#9-recommended-npm-dependencies)
10. [Out of Scope](#10-out-of-scope)
11. [Assumptions & Constraints](#11-assumptions--constraints)
12. [Acceptance Criteria](#12-acceptance-criteria)

---

## 1. Introduction

### 1.1 Purpose

This document defines the functional and non-functional requirements for a Node.js/Express web application that acts as an integration layer between home-grown internal workflows and the DocuSign eSignature platform. The application exposes a set of RESTful APIs that allow internal systems to submit documents for signature and react to signing events in a reliable, auditable manner.

### 1.2 Scope

The system covers the following capabilities:

- Submitting templated documents to DocuSign for customer signature.
- Receiving and validating webhook callbacks from DocuSign upon signing events.
- Extracting structured data (customer details, properties, ownership transfer) from completed envelopes.
- Pushing extracted data to a downstream external REST API.
- Logging all events and errors to a persistent store.
- Sending email alerts on failures.
- Exposing a lightweight status/monitoring dashboard UI.

### 1.3 Definitions & Acronyms

| Term | Definition |
|------|------------|
| Envelope | A DocuSign container holding one or more documents and one or more recipients. |
| Template | A pre-configured DocuSign document with defined tabs (fields) ready for recipient data. |
| Tab | A data field within a DocuSign template (e.g. text box, signature, date). |
| Webhook / Connect | DocuSign's event-notification mechanism that POSTs envelope status changes to a configured URL. |
| API Key | A shared secret header value (`x-api-key`) used to authenticate inbound calls to this service. |
| Downstream API | The external REST API that receives extracted signing data after envelope completion. |
| SRS | Software Requirements Specification (this document). |

---

## 2. System Overview

### 2.1 Architecture Summary

The application is a stateless Node.js/Express HTTP service. All persistent state (job status, audit logs, error records) is held in a local SQLite database (development) that can be swapped for PostgreSQL in production via an environment variable. The application communicates outward with two external services: the DocuSign eSignature API and the downstream REST API.

### 2.2 Logical Components

| Component | Responsibility |
|-----------|---------------|
| **API Layer** | Express router handling inbound requests and outbound responses. |
| **DocuSign Service** | Wrapper around the DocuSign eSignature SDK (JWT auth + envelope operations). |
| **Webhook Handler** | Validates HMAC signature, parses Connect payload, routes events. |
| **Data Extractor** | Maps DocuSign tab values to a canonical data model. |
| **Downstream Pusher** | Sends extracted data to the configured external REST API with retry logic. |
| **Event Store** | Persists envelope lifecycle events and extracted data. |
| **Error Logger** | Writes failures to an errors table and triggers email notifications. |
| **Dashboard** | Lightweight Express-served HTML page showing envelope and error status. |

---

## 3. Functional Requirements

Priority values: `MUST` = mandatory, `SHOULD` = strongly recommended, `MAY` = optional enhancement.

### 3.1 Document Submission

Internal workflows call this service to send a document to DocuSign. The service uses a pre-configured DocuSign template and merges caller-supplied data into the template tabs before dispatching an envelope.

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-SUB-01 | The API MUST accept a JSON payload containing: customer full name, email address, phone number, associated property details (address, lot number, title reference), and ownership transfer details (transfer date, consideration amount, transferor name). | MUST |
| FR-SUB-02 | The API MUST resolve the correct DocuSign Template ID from configuration (`DOCUSIGN_TEMPLATE_ID` env var) and create an envelope from that template. | MUST |
| FR-SUB-03 | The API MUST map all supplied fields to the corresponding DocuSign template tabs prior to sending. | MUST |
| FR-SUB-04 | The API MUST send the envelope in `sent` status so the customer receives the signing invitation email immediately. | MUST |
| FR-SUB-05 | The API MUST return the DocuSign envelope ID and a service-generated job reference ID in the response upon successful submission. | MUST |
| FR-SUB-06 | The API MUST persist a submission record (job ID, envelope ID, status=`SENT`, timestamps, raw request payload) in the event store. | MUST |
| FR-SUB-07 | The API SHOULD support an optional `callbackUrl` in the request payload that the service stores and calls once the envelope reaches a terminal state. | SHOULD |
| FR-SUB-08 | The API MUST return descriptive validation errors (HTTP 422) if required fields are missing or malformed. | MUST |
| FR-SUB-09 | The API SHOULD support idempotency via a caller-supplied `Idempotency-Key` header to prevent duplicate envelopes. | SHOULD |

### 3.2 DocuSign Webhook Callback

DocuSign calls this endpoint when envelope status changes (e.g. completed, declined, voided). The service must validate the call, persist the event, and trigger downstream processing on completion.

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-WH-01 | The webhook endpoint MUST be publicly accessible via HTTPS and registered in DocuSign Connect. | MUST |
| FR-WH-02 | The service MUST validate the HMAC-SHA256 signature supplied in the `X-DocuSign-Signature-1` header. Requests failing validation MUST be rejected with HTTP 401. | MUST |
| FR-WH-03 | The service MUST accept both JSON and XML DocuSign Connect payloads. | MUST |
| FR-WH-04 | The service MUST update the envelope's status record in the event store upon receiving any status event (`completed`, `declined`, `voided`, `sent`, `delivered`). | MUST |
| FR-WH-05 | On receipt of a `completed` event the service MUST trigger the data extraction and downstream push workflow. | MUST |
| FR-WH-06 | The webhook handler MUST respond with HTTP 200 within 10 seconds to prevent DocuSign retry storms; heavy processing MUST be dequeued asynchronously. | MUST |
| FR-WH-07 | The service MUST handle duplicate webhook deliveries idempotently — same envelope ID + status must not trigger duplicate downstream pushes. | MUST |

### 3.3 Data Extraction

Once an envelope is marked completed the service retrieves the signed document data from DocuSign and maps it to a canonical JSON payload.

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-EXT-01 | The service MUST call the DocuSign API to retrieve all tab values from the completed envelope. | MUST |
| FR-EXT-02 | The service MUST map the following fields: customer full name, customer email, customer phone, property address, lot number, title reference, transfer date, consideration amount, transferor name, signing completion timestamp, envelope ID. | MUST |
| FR-EXT-03 | The service MUST download the signed PDF and store a reference (local path or object storage key) in the event store. | MUST |
| FR-EXT-04 | The service MUST validate that all mandatory fields are populated in the extracted data before proceeding to the downstream push; if any are missing it MUST log an error and send an alert. | MUST |
| FR-EXT-05 | The service SHOULD make the signed PDF available for download via an authenticated GET endpoint. | SHOULD |

### 3.4 Downstream Push

Extracted data is forwarded to a configured external REST API endpoint.

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-PUSH-01 | The service MUST POST the canonical JSON payload to the configured `DOWNSTREAM_API_URL`. | MUST |
| FR-PUSH-02 | The service MUST authenticate to the downstream API using a configurable bearer token or API key defined in environment variables. | MUST |
| FR-PUSH-03 | On a non-2xx response or network error the service MUST retry up to 3 times with exponential back-off (1s, 5s, 15s). | MUST |
| FR-PUSH-04 | After all retries are exhausted the service MUST mark the job as `PUSH_FAILED`, log the error, and send an alert email. | MUST |
| FR-PUSH-05 | On success the service MUST update the job status to `COMPLETED` and record the downstream response code and timestamp. | MUST |
| FR-PUSH-06 | The service SHOULD expose a manual retry endpoint to re-trigger the downstream push for a given job ID. | SHOULD |

### 3.5 Error Logging & Alerting

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-ERR-01 | All errors MUST be written to an errors table in the event store with: job ID, envelope ID, error type, error message, stack trace, and timestamp. | MUST |
| FR-ERR-02 | On any ERROR-level event the service MUST send an email notification to the configured `ALERT_EMAIL` address. | MUST |
| FR-ERR-03 | Email notifications MUST include: error type, envelope ID, job ID, brief description, and a link to the dashboard detail page. | MUST |
| FR-ERR-04 | The service MUST rate-limit alert emails to a maximum of one email per envelope ID per error type within a 15-minute window to prevent alert storms. | MUST |
| FR-ERR-05 | All HTTP request/response pairs (inbound and outbound) MUST be logged at DEBUG level with personally identifiable information masked. | MUST |

### 3.6 Status & Monitoring Dashboard

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-DASH-01 | The dashboard MUST list all envelope jobs with: job ID, envelope ID, customer name, current status, submission time, and last updated time. | MUST |
| FR-DASH-02 | The dashboard MUST provide a detail view per job showing the full event timeline and any associated errors. | MUST |
| FR-DASH-03 | The dashboard MUST display a count of jobs in each status (`SENT`, `COMPLETED`, `DECLINED`, `PUSH_FAILED`, `ERROR`) as summary KPI cards. | MUST |
| FR-DASH-04 | The dashboard MUST support filtering jobs by status and date range. | MUST |
| FR-DASH-05 | The dashboard MUST be protected by the same API Key mechanism as the REST endpoints. | MUST |
| FR-DASH-06 | The dashboard SHOULD auto-refresh every 30 seconds. | SHOULD |

---

## 4. API Contract

### 4.1 Authentication

All API endpoints (including the dashboard) require the header:

```
x-api-key: <value of API_KEY env var>
```

The webhook endpoint additionally validates the DocuSign HMAC-SHA256 signature via `X-DocuSign-Signature-1`.

### 4.2 Endpoint Summary

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/envelopes` | Submit a document for signature | API Key |
| `GET` | `/api/v1/envelopes` | List envelopes with optional filters | API Key |
| `GET` | `/api/v1/envelopes/:jobId` | Get full detail and event timeline for a job | API Key |
| `GET` | `/api/v1/envelopes/:jobId/document` | Download the signed PDF | API Key |
| `POST` | `/api/v1/envelopes/:jobId/retry` | Manually retry a failed downstream push | API Key |
| `POST` | `/api/v1/webhook/docusign` | DocuSign Connect callback receiver | HMAC Only |
| `GET` | `/dashboard` | Status monitoring dashboard (HTML) | API Key |
| `GET` | `/health` | Liveness probe — returns `{ status: "ok" }` | None |

### 4.3 `POST /api/v1/envelopes` — Request Body

```json
{
  "customer": {
    "fullName": "string (required)",
    "email": "string (required)",
    "phone": "string (optional)"
  },
  "property": {
    "address": "string (required)",
    "lotNumber": "string (required)",
    "titleReference": "string (required)"
  },
  "transfer": {
    "date": "ISO 8601 date (required)",
    "considerationAmount": "number (required)",
    "transferorName": "string (required)"
  },
  "idempotencyKey": "string (optional)",
  "callbackUrl": "string (optional)"
}
```

**Success Response — HTTP 202**

```json
{
  "jobId": "uuid-v4",
  "envelopeId": "docusign-envelope-id",
  "status": "SENT"
}
```

### 4.4 Canonical Downstream Payload

This structure is POSTed to the downstream REST API after successful data extraction:

```json
{
  "jobId": "uuid-v4",
  "envelopeId": "docusign-envelope-id",
  "signedAt": "ISO-8601 timestamp",
  "customer": {
    "fullName": "string",
    "email": "string",
    "phone": "string | null"
  },
  "property": {
    "address": "string",
    "lotNumber": "string",
    "titleReference": "string"
  },
  "transfer": {
    "date": "ISO-8601 date",
    "considerationAmount": 0.00,
    "transferorName": "string"
  },
  "documentUrl": "/api/v1/envelopes/{jobId}/document"
}
```

### 4.5 DocuSign Template Tab Mapping

The following tab labels must exist in the DocuSign template and map to request fields:

| Tab Label (DocuSign) | Source Field |
|----------------------|-------------|
| `customer_full_name` | `customer.fullName` |
| `customer_email` | `customer.email` |
| `customer_phone` | `customer.phone` |
| `property_address` | `property.address` |
| `property_lot_number` | `property.lotNumber` |
| `property_title_reference` | `property.titleReference` |
| `transfer_date` | `transfer.date` |
| `transfer_consideration_amount` | `transfer.considerationAmount` |
| `transfer_transferor_name` | `transfer.transferorName` |

---

## 5. Non-Functional Requirements

### 5.1 Performance

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-PERF-01 | Submission endpoint MUST respond within 5 seconds under normal DocuSign API latency. | MUST |
| NFR-PERF-02 | Webhook endpoint MUST acknowledge receipt within 10 seconds (async processing thereafter). | MUST |
| NFR-PERF-03 | Dashboard page MUST load within 3 seconds for up to 1,000 envelope records. | SHOULD |

### 5.2 Security

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-SEC-01 | All endpoints MUST be served over HTTPS. HTTP requests MUST redirect to HTTPS. | MUST |
| NFR-SEC-02 | API keys MUST be stored as environment variables and NEVER committed to source control. | MUST |
| NFR-SEC-03 | DocuSign OAuth 2.0 JWT credentials MUST be stored as environment variables. | MUST |
| NFR-SEC-04 | The webhook endpoint MUST reject calls that fail HMAC-SHA256 signature validation. | MUST |
| NFR-SEC-05 | All request logs MUST mask PII fields (email, phone, full name) beyond the first 3 characters. | MUST |
| NFR-SEC-06 | The service MUST implement rate limiting on the submission endpoint (max 60 requests/min per API key). | SHOULD |

### 5.3 Reliability & Error Handling

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-REL-01 | The service MUST implement retry logic (3 attempts, exponential back-off) for all outbound HTTP calls. | MUST |
| NFR-REL-02 | A graceful shutdown handler MUST flush in-progress async jobs before the process exits. | MUST |
| NFR-REL-03 | The `/health` endpoint MUST return HTTP 200 when the service and database are reachable. | MUST |
| NFR-REL-04 | Failed downstream pushes MUST remain queryable and manually retriable indefinitely. | MUST |

### 5.4 Observability

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-OBS-01 | All log output MUST be structured JSON (using `pino` or `winston`). | MUST |
| NFR-OBS-02 | Each log line MUST include: timestamp, log level, request ID (uuid per request), envelope ID (if applicable), and message. | MUST |
| NFR-OBS-03 | Log level MUST be configurable via `LOG_LEVEL` environment variable (default: `info`). | MUST |

### 5.5 Maintainability

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-MAINT-01 | All configuration MUST be driven by environment variables with a `.env.example` file documenting every variable. | MUST |
| NFR-MAINT-02 | The codebase MUST include unit tests covering the data extractor and downstream pusher modules (target: 80% coverage). | SHOULD |
| NFR-MAINT-03 | The project MUST include a README with local setup instructions and a description of every environment variable. | MUST |

---

## 6. Environment Variables

| Variable | Example Value | Description |
|----------|--------------|-------------|
| `NODE_ENV` | `production` | Runtime environment (`development` \| `production`) |
| `PORT` | `3000` | HTTP port the Express server listens on |
| `API_KEY` | `changeme-secret` | API key required on all inbound requests |
| `DOCUSIGN_ACCOUNT_ID` | `xxxxxxxx-xxxx-xxxx` | DocuSign account (integrator) GUID |
| `DOCUSIGN_CLIENT_ID` | `xxxxxxxx-xxxx-xxxx` | DocuSign OAuth app client ID |
| `DOCUSIGN_USER_ID` | `xxxxxxxx-xxxx-xxxx` | DocuSign impersonated user GUID |
| `DOCUSIGN_PRIVATE_KEY_PATH` | `./certs/docusign.pem` | Path to RSA private key for JWT auth |
| `DOCUSIGN_BASE_URL` | `https://demo.docusign.net/restapi` | DocuSign API base URL (sandbox) |
| `DOCUSIGN_TEMPLATE_ID` | `xxxxxxxx-xxxx-xxxx` | Template GUID used for envelope creation |
| `DOCUSIGN_HMAC_KEY` | `changeme-hmac` | Secret key for Connect HMAC validation |
| `DOWNSTREAM_API_URL` | `https://api.example.com/v1/transfers` | Target REST API endpoint |
| `DOWNSTREAM_API_KEY` | `changeme-downstream` | Auth token for downstream API |
| `ALERT_EMAIL` | `ops@example.com` | Recipient for error alert emails |
| `SMTP_HOST` | `smtp.example.com` | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP server port |
| `SMTP_USER` | `noreply@example.com` | SMTP authentication username |
| `SMTP_PASS` | `changeme-smtp` | SMTP authentication password |
| `DATABASE_URL` | `file:./data/app.db` | SQLite (dev) or PostgreSQL connection string |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug` \| `info` \| `warn` \| `error`) |
| `SIGNED_DOCS_PATH` | `./storage/signed` | Local path to store downloaded signed PDFs |

---

## 7. Data Model

### 7.1 `envelopes` Table

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID | No | Primary key, service-generated job ID |
| `envelope_id` | VARCHAR | Yes | DocuSign envelope GUID (set after successful send) |
| `status` | VARCHAR | No | `SENT` \| `COMPLETED` \| `DECLINED` \| `VOIDED` \| `PUSH_FAILED` \| `ERROR` |
| `customer_name` | VARCHAR | No | Customer full name (submitted) |
| `customer_email` | VARCHAR | No | Customer email (submitted) |
| `request_payload` | JSONB/TEXT | No | Full raw inbound request payload |
| `extracted_data` | JSONB/TEXT | Yes | Canonical payload after extraction |
| `document_path` | VARCHAR | Yes | File path / key to stored signed PDF |
| `callback_url` | VARCHAR | Yes | Optional caller-supplied callback URL |
| `idempotency_key` | VARCHAR | Yes | Caller-supplied dedup key (unique index) |
| `created_at` | TIMESTAMP | No | Record creation time (UTC) |
| `updated_at` | TIMESTAMP | No | Last status change time (UTC) |

### 7.2 `events` Table

Stores the full lifecycle event timeline per envelope — one row per DocuSign Connect callback or internal state transition.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID | No | Primary key |
| `job_id` | UUID | No | Foreign key → `envelopes.id` |
| `event_type` | VARCHAR | No | `SUBMITTED` \| `SENT` \| `DELIVERED` \| `COMPLETED` \| `DECLINED` \| `VOIDED` \| `PUSH_SUCCESS` \| `PUSH_FAILED` \| `EXTRACTION_ERROR` |
| `payload` | JSONB/TEXT | Yes | Raw DocuSign Connect payload or internal event detail |
| `created_at` | TIMESTAMP | No | Event timestamp (UTC) |

### 7.3 `errors` Table

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID | No | Primary key |
| `job_id` | UUID | Yes | Foreign key → `envelopes.id` (null for global errors) |
| `error_type` | VARCHAR | No | `SUBMISSION_FAILED` \| `WEBHOOK_VALIDATION` \| `EXTRACTION_FAILED` \| `PUSH_FAILED` \| `UNKNOWN` |
| `message` | TEXT | No | Human-readable error summary |
| `stack_trace` | TEXT | Yes | Full stack trace |
| `alert_sent` | BOOLEAN | No | True if alert email was dispatched |
| `created_at` | TIMESTAMP | No | Error timestamp (UTC) |

---

## 8. Suggested Project Structure

```
docusign-integration/
├── src/
│   ├── app.js                    # Express app factory
│   ├── server.js                 # Entry point, port binding
│   ├── config/
│   │   └── index.js              # env var loader & validation
│   ├── routes/
│   │   ├── envelopes.js          # POST/GET /api/v1/envelopes
│   │   └── webhook.js            # POST /api/v1/webhook/docusign
│   ├── services/
│   │   ├── docusignService.js    # DocuSign SDK wrapper (JWT auth, envelope ops)
│   │   ├── extractorService.js   # Tab → canonical model mapping
│   │   ├── pushService.js        # Downstream REST API calls + retry
│   │   └── alertService.js       # Email notification via nodemailer
│   ├── middleware/
│   │   ├── apiKeyAuth.js         # x-api-key validation
│   │   ├── hmacValidator.js      # DocuSign Connect HMAC check
│   │   └── requestLogger.js      # Structured JSON request logging
│   ├── db/
│   │   ├── client.js             # DB connection (SQLite dev / PG prod)
│   │   └── migrations/           # SQL migration files
│   ├── dashboard/
│   │   └── index.html            # Server-rendered dashboard template
│   └── utils/
│       ├── logger.js             # pino / winston setup
│       └── retry.js              # Generic exponential back-off helper
├── tests/
│   ├── extractor.test.js
│   └── pushService.test.js
├── .env.example
├── package.json
└── README.md
```

---

## 9. Recommended npm Dependencies

| Package | Category | Purpose |
|---------|----------|---------|
| `express` | Core | HTTP server and routing |
| `docusign-esign` | DocuSign | Official DocuSign eSignature SDK |
| `jsonwebtoken` | DocuSign | JWT generation for DocuSign OAuth |
| `axios` | HTTP | Outbound HTTP calls to downstream API |
| `pino` + `pino-http` | Logging | Structured JSON logging with request correlation |
| `nodemailer` | Alerts | SMTP email dispatch for error notifications |
| `better-sqlite3` | Database | SQLite driver for local/dev persistence |
| `pg` | Database | PostgreSQL driver for production use |
| `zod` | Validation | Runtime request body validation and schema definition |
| `uuid` | Utility | UUID v4 generation for job IDs and idempotency |
| `express-rate-limit` | Security | Rate limiting middleware for submission endpoint |
| `helmet` | Security | Sets secure HTTP response headers |
| `dotenv` | Config | Loads `.env` file into `process.env` |
| `jest` + `supertest` | Testing | Unit and integration test framework |

---

## 10. Out of Scope

The following items are explicitly out of scope for this initial version:

- Multi-tenant / multi-API-key management UI.
- Support for multiple simultaneous DocuSign templates.
- PDF generation or pre-filling before DocuSign submission.
- Real-time WebSocket push to dashboard (polling via meta refresh is sufficient for v1).
- Production DocuSign environment configuration (sandbox only for this phase).
- Role-based access control within the dashboard.
- CI/CD pipeline configuration.

---

## 11. Assumptions & Constraints

- A DocuSign Developer (Sandbox) account with an active Integration Key and RSA key pair will be provisioned before development begins.
- The DocuSign template will be pre-built in the sandbox account; the template's tab labels will exactly match the field names defined in [Section 4.5](#45-docusign-template-tab-mapping).
- The downstream external REST API is already operational and documented; its auth mechanism is a bearer token or API key.
- An SMTP relay (e.g. SendGrid, AWS SES, or corporate SMTP) is available for alert emails.
- The initial deployment target is a single Node.js process on a VM or container; horizontal scaling is out of scope for v1.
- SQLite is acceptable for development; a `DATABASE_URL` swap to PostgreSQL is sufficient for production hardening.

---

## 12. Acceptance Criteria

The following end-to-end scenarios must pass before the system is considered complete:

1. `POST /api/v1/envelopes` with a valid payload creates an envelope in DocuSign sandbox and returns HTTP 202 with `envelopeId` and `jobId`.
2. The customer receives a DocuSign signing invitation email in the sandbox.
3. After the customer signs, DocuSign fires a Connect webhook; the service validates the HMAC and responds HTTP 200 within 10 seconds.
4. The event store is updated with `status=COMPLETED` and the extracted data matches the signed document tabs.
5. The canonical payload is successfully POSTed to the downstream API mock; job status transitions to `COMPLETED`.
6. Deliberately failing the downstream API (returning 500) causes three retry attempts, logs an error record, sends an alert email, and marks the job `PUSH_FAILED`.
7. The `/dashboard` page renders all jobs with correct statuses, KPI counts, and filters by status and date.
8. Submitting the same payload twice with the same `Idempotency-Key` returns HTTP 200 (cached response) with no duplicate envelope created.
9. A request with a missing or wrong `x-api-key` is rejected with HTTP 401.
10. A webhook call with an invalid HMAC signature is rejected with HTTP 401.

---

*End of Requirements Document — v1.0*
