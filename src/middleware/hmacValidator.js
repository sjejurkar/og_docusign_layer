const crypto = require('crypto');
const { logger } = require('../utils/logger');

/**
 * DocuSign Connect HMAC-SHA256 signature validator middleware
 *
 * Validates the X-DocuSign-Signature-1 header against the request body
 * using the configured HMAC key.
 *
 * Important: This middleware requires the raw request body to be available
 * at req.rawBody. Configure Express body parser with verify option to capture this.
 *
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware
 */
function hmacValidator(req, res, next) {
  const config = require('../config');
  const signature = req.headers['x-docusign-signature-1'];

  // Log webhook attempt
  logger.debug({ headers: Object.keys(req.headers) }, 'Validating DocuSign webhook signature');

  if (!signature) {
    logger.warn({ ip: req.ip }, 'Missing DocuSign signature header');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing X-DocuSign-Signature-1 header'
    });
  }

  // Get raw body (must be captured during body parsing)
  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.error('Raw body not available for HMAC validation');
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Unable to validate signature'
    });
  }

  // Compute HMAC-SHA256
  const computed = crypto
    .createHmac('sha256', config.docusign.hmacKey)
    .update(rawBody)
    .digest('base64');

  // Compare signatures using timing-safe comparison
  try {
    const signatureBuffer = Buffer.from(signature, 'base64');
    const computedBuffer = Buffer.from(computed, 'base64');

    if (signatureBuffer.length !== computedBuffer.length) {
      throw new Error('Signature length mismatch');
    }

    if (!crypto.timingSafeEqual(signatureBuffer, computedBuffer)) {
      throw new Error('Signature mismatch');
    }
  } catch (error) {
    logger.warn({ ip: req.ip, error: error.message }, 'Invalid DocuSign HMAC signature');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid HMAC signature'
    });
  }

  logger.debug('DocuSign HMAC signature validated successfully');
  next();
}

/**
 * Generate HMAC signature for testing
 * @param {string|Buffer} payload - Request body
 * @param {string} secretKey - HMAC secret key
 * @returns {string} - Base64 encoded HMAC-SHA256 signature
 */
function generateSignature(payload, secretKey) {
  return crypto
    .createHmac('sha256', secretKey)
    .update(payload)
    .digest('base64');
}

module.exports = {
  hmacValidator,
  generateSignature
};
