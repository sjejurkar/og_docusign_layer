const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { z } = require('zod');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const db = require('../db/client');
const { logger } = require('../utils/logger');

// Lazy load services to avoid circular dependencies
let docusignService = null;
let pushService = null;
let alertService = null;

function getServices() {
  if (!docusignService) {
    const config = require('../config');
    const { getInstance: getDocuSign } = require('../services/docusignService');
    const { getInstance: getPush } = require('../services/pushService');
    const { getInstance: getAlert } = require('../services/alertService');
    docusignService = getDocuSign(config);
    pushService = getPush(config);
    alertService = getAlert(config);
  }
  return { docusignService, pushService, alertService };
}

// Request validation schema
const createEnvelopeSchema = z.object({
  owner: z.object({
    firstName: z.string().min(1, 'Owner first name is required'),
    middleName: z.string().nullable().optional(),
    lastName: z.string().min(1, 'Owner last name is required'),
    ownerNumber: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email('Valid owner email is required'),
    address: z.string().min(1, 'Owner address is required')
  }),
  asset: z.object({
    assetNumber: z.string().min(1, 'Asset number is required'),
    assetName: z.string().min(1, 'Asset name is required'),
    assetLocation: z.string().min(1, 'Asset location is required')
  }),
  transferee: z.object({
    firstName: z.string().min(1, 'Transferee first name is required'),
    middleName: z.string().nullable().optional(),
    lastName: z.string().min(1, 'Transferee last name is required')
  }),
  idempotencyKey: z.string().optional(),
  callbackUrl: z.string().url().optional()
});

/**
 * POST /api/v1/envelopes
 * Submit a document for signature
 */
router.post('/', async (req, res, next) => {
  const log = req.log || logger;

  try {
    // Validate request body
    const validationResult = createEnvelopeSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(422).json({
        error: 'Validation Error',
        details: validationResult.error.issues.map(issue => ({
          field: issue.path.join('.'),
          message: issue.message
        }))
      });
    }

    const data = validationResult.data;
    const idempotencyKey = data.idempotencyKey || req.headers['idempotency-key'];

    // Check idempotency
    if (idempotencyKey) {
      const existing = await db.getOne(
        'SELECT id, envelope_id, status FROM envelopes WHERE idempotency_key = ?',
        [idempotencyKey]
      );

      if (existing) {
        log.info({ jobId: existing.id, idempotencyKey }, 'Returning cached envelope (idempotency)');
        return res.status(200).json({
          jobId: existing.id,
          envelopeId: existing.envelope_id,
          status: existing.status
        });
      }
    }

    // Generate job ID
    const jobId = uuidv4();

    // Create envelope in DocuSign
    const { docusignService } = getServices();
    const envelopeId = await docusignService.createEnvelopeFromTemplate(data);

    // Build owner full name
    const ownerFullName = [data.owner.firstName, data.owner.middleName, data.owner.lastName]
      .filter(Boolean)
      .join(' ');

    // Persist to database
    await db.run(`
      INSERT INTO envelopes (id, envelope_id, status, customer_name, customer_email, request_payload, callback_url, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      jobId,
      envelopeId,
      'SENT',
      ownerFullName,
      data.owner.email,
      JSON.stringify(data),
      data.callbackUrl || null,
      idempotencyKey || null
    ]);

    // Log submission event
    await db.run(`
      INSERT INTO events (id, job_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [uuidv4(), jobId, 'SUBMITTED', JSON.stringify(data)]);

    log.info({ jobId, envelopeId }, 'Envelope submitted successfully');

    res.status(202).json({
      jobId,
      envelopeId,
      status: 'SENT'
    });
  } catch (error) {
    log.error({ error: error.message }, 'Envelope submission failed');
    next(error);
  }
});

/**
 * GET /api/v1/envelopes
 * List envelopes with optional filters
 */
router.get('/', async (req, res, next) => {
  try {
    const { status, from, to, limit = 50, offset = 0 } = req.query;

    let sql = 'SELECT * FROM envelopes WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status.toUpperCase());
    }

    if (from) {
      sql += ' AND created_at >= ?';
      params.push(from);
    }

    if (to) {
      sql += ' AND created_at <= ?';
      params.push(to);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const envelopes = await db.query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) as count FROM envelopes WHERE 1=1';
    const countParams = [];
    if (status) {
      countSql += ' AND status = ?';
      countParams.push(status.toUpperCase());
    }
    if (from) {
      countSql += ' AND created_at >= ?';
      countParams.push(from);
    }
    if (to) {
      countSql += ' AND created_at <= ?';
      countParams.push(to);
    }

    const countResult = await db.getOne(countSql, countParams);
    const total = countResult?.count || 0;

    res.json({
      data: envelopes.map(e => ({
        jobId: e.id,
        envelopeId: e.envelope_id,
        status: e.status,
        customerName: e.customer_name,
        customerEmail: e.customer_email,
        createdAt: e.created_at,
        updatedAt: e.updated_at
      })),
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/envelopes/:jobId
 * Get job detail with event timeline
 */
router.get('/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;

    // Get envelope
    const envelope = await db.getOne('SELECT * FROM envelopes WHERE id = ?', [jobId]);

    if (!envelope) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Envelope with job ID ${jobId} not found`
      });
    }

    // Get events
    const events = await db.query(
      'SELECT * FROM events WHERE job_id = ? ORDER BY created_at ASC',
      [jobId]
    );

    // Get errors
    const errors = await db.query(
      'SELECT * FROM errors WHERE job_id = ? ORDER BY created_at DESC',
      [jobId]
    );

    res.json({
      jobId: envelope.id,
      envelopeId: envelope.envelope_id,
      status: envelope.status,
      customerName: envelope.customer_name,
      customerEmail: envelope.customer_email,
      documentPath: envelope.document_path,
      extractedData: envelope.extracted_data ? JSON.parse(envelope.extracted_data) : null,
      callbackUrl: envelope.callback_url,
      createdAt: envelope.created_at,
      updatedAt: envelope.updated_at,
      events: events.map(e => ({
        id: e.id,
        type: e.event_type,
        payload: e.payload ? JSON.parse(e.payload) : null,
        createdAt: e.created_at
      })),
      errors: errors.map(e => ({
        id: e.id,
        type: e.error_type,
        message: e.message,
        alertSent: !!e.alert_sent,
        createdAt: e.created_at
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/envelopes/:jobId/document
 * Download signed PDF
 */
router.get('/:jobId/document', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const config = require('../config');

    // Get envelope
    const envelope = await db.getOne('SELECT * FROM envelopes WHERE id = ?', [jobId]);

    if (!envelope) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Envelope with job ID ${jobId} not found`
      });
    }

    if (!envelope.document_path) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Signed document not yet available'
      });
    }

    const documentPath = envelope.document_path;

    if (!fs.existsSync(documentPath)) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Document file not found on server'
      });
    }

    // Send file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="signed-${jobId}.pdf"`);
    fs.createReadStream(documentPath).pipe(res);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/envelopes/:jobId/retry
 * Manually retry a failed downstream push
 */
router.post('/:jobId/retry', async (req, res, next) => {
  const log = req.log || logger;

  try {
    const { jobId } = req.params;

    // Get envelope
    const envelope = await db.getOne('SELECT * FROM envelopes WHERE id = ?', [jobId]);

    if (!envelope) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Envelope with job ID ${jobId} not found`
      });
    }

    if (envelope.status !== 'PUSH_FAILED') {
      return res.status(400).json({
        error: 'Bad Request',
        message: `Cannot retry envelope with status ${envelope.status}. Only PUSH_FAILED envelopes can be retried.`
      });
    }

    if (!envelope.extracted_data) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'No extracted data available for retry'
      });
    }

    const extractedData = JSON.parse(envelope.extracted_data);
    const { pushService } = getServices();

    log.info({ jobId }, 'Manual retry initiated');

    // Attempt push
    try {
      const result = await pushService.pushData(extractedData);

      // Update status
      await db.run(
        'UPDATE envelopes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['COMPLETED', jobId]
      );

      // Log success event
      await db.run(`
        INSERT INTO events (id, job_id, event_type, payload, created_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [uuidv4(), jobId, 'PUSH_SUCCESS', JSON.stringify({ manual: true, statusCode: result.statusCode })]);

      log.info({ jobId }, 'Manual retry successful');

      res.json({
        success: true,
        message: 'Retry successful',
        status: 'COMPLETED'
      });
    } catch (pushError) {
      // Log failure
      await db.run(`
        INSERT INTO errors (id, job_id, error_type, message, stack_trace, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [uuidv4(), jobId, 'PUSH_FAILED', pushError.message, pushError.stack]);

      log.error({ jobId, error: pushError.message }, 'Manual retry failed');

      res.status(502).json({
        success: false,
        message: 'Retry failed',
        error: pushError.message
      });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
