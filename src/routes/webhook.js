const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { parseStringPromise } = require('xml2js');
const path = require('path');
const router = express.Router();

const db = require('../db/client');
const { hmacValidator } = require('../middleware/hmacValidator');
const { logger } = require('../utils/logger');
const { extractData } = require('../services/extractorService');

// Lazy load services
let docusignService = null;
let pushService = null;
let alertService = null;
let config = null;

function getServices() {
  if (!docusignService) {
    config = require('../config');
    const { getInstance: getDocuSign } = require('../services/docusignService');
    const { getInstance: getPush } = require('../services/pushService');
    const { getInstance: getAlert } = require('../services/alertService');
    docusignService = getDocuSign(config);
    pushService = getPush(config);
    alertService = getAlert(config);
  }
  return { docusignService, pushService, alertService, config };
}

/**
 * POST /api/v1/webhook/docusign
 * DocuSign Connect webhook receiver
 */
router.post('/docusign', hmacValidator, async (req, res) => {
  const log = logger.child({ webhook: 'docusign' });

  try {
    // Parse payload (JSON or XML)
    let payload;
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('xml')) {
      // Parse XML payload
      const xmlString = typeof req.body === 'string' ? req.body : req.rawBody.toString();
      const parsed = await parseStringPromise(xmlString, { explicitArray: false });
      payload = normalizeXmlPayload(parsed);
    } else {
      // JSON payload
      payload = req.body;
    }

    // Handle both legacy format (top-level) and new Connect format (nested in data)
    const envelopeId = payload.envelopeId || payload.EnvelopeID ||
                       payload.data?.envelopeId || payload.data?.EnvelopeID;
    const status = (payload.status || payload.Status ||
                    payload.data?.envelopeSummary?.status || '').toLowerCase();

    log.info({ envelopeId, status }, 'Processing webhook event');

    if (!envelopeId) {
      log.warn('Webhook payload missing envelope ID');
      return res.status(200).json({ received: true, processed: false, reason: 'missing_envelope_id' });
    }

    // Find job by envelope ID
    const job = await db.getOne(
      'SELECT * FROM envelopes WHERE envelope_id = ?',
      [envelopeId]
    );

    if (!job) {
      log.warn({ envelopeId }, 'Received webhook for unknown envelope');
      return res.status(200).json({ received: true, processed: false, reason: 'unknown_envelope' });
    }

    const jobLog = log.child({ jobId: job.id, envelopeId });

    // Check for duplicate event (idempotency)
    const statusUpper = status.toUpperCase();
    const existingEvent = await db.getOne(
      'SELECT id FROM events WHERE job_id = ? AND event_type = ?',
      [job.id, statusUpper]
    );

    if (existingEvent) {
      jobLog.info({ status: statusUpper }, 'Duplicate webhook event, skipping');
      return res.status(200).json({ received: true, processed: false, reason: 'duplicate' });
    }

    // Record event
    await db.run(`
      INSERT INTO events (id, job_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [uuidv4(), job.id, statusUpper, JSON.stringify(payload)]);

    // Update envelope status
    await db.run(
      'UPDATE envelopes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [statusUpper, job.id]
    );

    jobLog.info({ status: statusUpper }, 'Envelope status updated');

    // If completed, trigger extraction and push
    if (status === 'completed') {
      await processCompletedEnvelope(job, jobLog);
    }

    return res.status(200).json({ received: true, processed: true });
  } catch (error) {
    log.error({ error: error.message, stack: error.stack }, 'Webhook processing error');

    // Log error to database
    try {
      await logError(error, 'WEBHOOK_PROCESSING', null, null);
    } catch (dbError) {
      log.error({ error: dbError.message }, 'Failed to log webhook error');
    }

    // Still return 200 to prevent DocuSign from retrying
    return res.status(200).json({ received: true, processed: false, reason: 'error' });
  }
});

/**
 * Process a completed envelope: extract data, download document, push to downstream
 */
async function processCompletedEnvelope(job, log) {
  const { docusignService, pushService, alertService, config } = getServices();

  try {
    log.info('Processing completed envelope');

    // Get tab values from DocuSign
    const tabs = await docusignService.getEnvelopeTabs(job.envelope_id);

    // Download signed document
    const documentPath = path.join(config.signedDocsPath, `${job.id}.pdf`);
    await docusignService.downloadSignedDocument(job.envelope_id, documentPath);

    log.info({ documentPath }, 'Document downloaded');

    // Extract data
    const extractedData = extractData(tabs, {
      jobId: job.id,
      envelopeId: job.envelope_id,
      completedAt: new Date().toISOString()
    });

    // Update envelope with extracted data and document path
    await db.run(
      'UPDATE envelopes SET extracted_data = ?, document_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [JSON.stringify(extractedData), documentPath, job.id]
    );

    log.info('Data extracted successfully');

    // Push to downstream API
    try {
      const pushResult = await pushService.pushData(extractedData);

      // Update status to COMPLETED
      await db.run(
        'UPDATE envelopes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['COMPLETED', job.id]
      );

      // Log success event
      await db.run(`
        INSERT INTO events (id, job_id, event_type, payload, created_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [uuidv4(), job.id, 'PUSH_SUCCESS', JSON.stringify({ statusCode: pushResult.statusCode })]);

      log.info('Downstream push successful');

      // Call callback URL if configured
      if (job.callback_url) {
        try {
          const axios = require('axios');
          await axios.post(job.callback_url, extractedData, { timeout: 10000 });
          log.info({ callbackUrl: job.callback_url }, 'Callback URL notified');
        } catch (callbackError) {
          log.warn({ error: callbackError.message }, 'Callback URL notification failed');
        }
      }
    } catch (pushError) {
      // Push failed after all retries
      await handlePushFailure(job, pushError, extractedData, log);
    }
  } catch (error) {
    // Extraction or document download failed
    log.error({ error: error.message }, 'Envelope processing failed');

    await db.run(
      'UPDATE envelopes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['ERROR', job.id]
    );

    await logError(error, 'EXTRACTION_FAILED', job.id, job.envelope_id);

    // Send alert
    await alertService.sendAlert(
      { type: 'EXTRACTION_FAILED', message: error.message, stack: error.stack },
      { jobId: job.id, envelopeId: job.envelope_id }
    );
  }
}

/**
 * Handle push failure: update status, log error, send alert
 */
async function handlePushFailure(job, error, extractedData, log) {
  const { alertService } = getServices();

  log.error({ error: error.message }, 'Downstream push failed');

  // Update status
  await db.run(
    'UPDATE envelopes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    ['PUSH_FAILED', job.id]
  );

  // Log failure event
  await db.run(`
    INSERT INTO events (id, job_id, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [uuidv4(), job.id, 'PUSH_FAILED', JSON.stringify({ error: error.message })]);

  // Log error
  await logError(error, 'PUSH_FAILED', job.id, job.envelope_id);

  // Send alert
  const alertSent = await alertService.sendAlert(
    { type: 'PUSH_FAILED', message: error.message, stack: error.stack },
    { jobId: job.id, envelopeId: job.envelope_id }
  );

  // Update alert_sent flag
  if (alertSent) {
    await db.run(
      'UPDATE errors SET alert_sent = 1 WHERE job_id = ? AND error_type = ? AND alert_sent = 0',
      [job.id, 'PUSH_FAILED']
    );
  }
}

/**
 * Log an error to the database
 */
async function logError(error, errorType, jobId, envelopeId) {
  await db.run(`
    INSERT INTO errors (id, job_id, error_type, message, stack_trace, created_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [uuidv4(), jobId, errorType, error.message, error.stack]);
}

/**
 * Normalize XML payload to match JSON structure
 */
function normalizeXmlPayload(parsed) {
  // DocuSign Connect XML has nested structure
  const envelope = parsed.DocuSignEnvelopeInformation?.EnvelopeStatus || parsed;

  return {
    envelopeId: envelope.EnvelopeID || envelope.envelopeId,
    status: envelope.Status || envelope.status,
    subject: envelope.Subject || envelope.subject,
    sentDateTime: envelope.Sent || envelope.sentDateTime,
    completedDateTime: envelope.Completed || envelope.completedDateTime,
    // Add more fields as needed
    raw: envelope
  };
}

module.exports = router;
