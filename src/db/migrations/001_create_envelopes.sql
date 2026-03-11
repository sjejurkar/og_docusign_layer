-- Envelopes table: Job tracking for document signing workflows
CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  envelope_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  request_payload TEXT NOT NULL,
  extracted_data TEXT,
  document_path TEXT,
  callback_url TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_envelopes_status ON envelopes(status);
CREATE INDEX IF NOT EXISTS idx_envelopes_envelope_id ON envelopes(envelope_id);
CREATE INDEX IF NOT EXISTS idx_envelopes_created_at ON envelopes(created_at);
