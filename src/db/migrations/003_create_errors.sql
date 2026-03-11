-- Errors table: Error logging with alert tracking
CREATE TABLE IF NOT EXISTS errors (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  error_type TEXT NOT NULL,
  message TEXT NOT NULL,
  stack_trace TEXT,
  alert_sent INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES envelopes(id) ON DELETE SET NULL
);

-- Indexes for error queries
CREATE INDEX IF NOT EXISTS idx_errors_job_id ON errors(job_id);
CREATE INDEX IF NOT EXISTS idx_errors_error_type ON errors(error_type);
CREATE INDEX IF NOT EXISTS idx_errors_created_at ON errors(created_at);
