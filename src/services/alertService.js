const nodemailer = require('nodemailer');
const { logger } = require('../utils/logger');

class AlertService {
  constructor(config) {
    this.config = config;
    this.log = logger.child({ service: 'alert' });

    // Create nodemailer transporter
    this.transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465, // true for 465, false for other ports
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass
      }
    });

    // Rate limiting: Map of "envelopeId:errorType" -> lastSentTimestamp
    this.rateLimitCache = new Map();
    this.rateLimitWindow = 15 * 60 * 1000; // 15 minutes in ms
  }

  /**
   * Check if an alert should be rate limited
   *
   * @param {string} envelopeId - Envelope ID
   * @param {string} errorType - Type of error
   * @returns {boolean} - True if rate limited (should not send)
   */
  isRateLimited(envelopeId, errorType) {
    const cacheKey = `${envelopeId}:${errorType}`;
    const lastSent = this.rateLimitCache.get(cacheKey);

    if (lastSent && Date.now() - lastSent < this.rateLimitWindow) {
      return true;
    }

    return false;
  }

  /**
   * Record that an alert was sent
   *
   * @param {string} envelopeId - Envelope ID
   * @param {string} errorType - Type of error
   */
  recordAlertSent(envelopeId, errorType) {
    const cacheKey = `${envelopeId}:${errorType}`;
    this.rateLimitCache.set(cacheKey, Date.now());

    // Clean up old entries periodically
    if (this.rateLimitCache.size > 1000) {
      this.cleanupRateLimitCache();
    }
  }

  /**
   * Remove expired entries from rate limit cache
   */
  cleanupRateLimitCache() {
    const now = Date.now();
    for (const [key, timestamp] of this.rateLimitCache.entries()) {
      if (now - timestamp > this.rateLimitWindow) {
        this.rateLimitCache.delete(key);
      }
    }
  }

  /**
   * Send an error alert email
   *
   * @param {Object} error - Error details { type, message, stack }
   * @param {Object} context - Context { jobId, envelopeId }
   * @returns {boolean} - True if email was sent, false if rate limited or failed
   */
  async sendAlert(error, context) {
    const { jobId, envelopeId } = context;

    // Check rate limit
    if (this.isRateLimited(envelopeId, error.type)) {
      this.log.debug(
        { envelopeId, errorType: error.type },
        'Alert rate limited, skipping email'
      );
      return false;
    }

    const mailOptions = {
      from: this.config.smtp.user,
      to: this.config.alert.email,
      subject: `[DocuSign Integration] Error: ${error.type}`,
      html: this.formatEmailBody(error, context)
    };

    try {
      await this.transporter.sendMail(mailOptions);

      this.recordAlertSent(envelopeId, error.type);

      this.log.info(
        { envelopeId, jobId, errorType: error.type },
        'Alert email sent'
      );

      return true;
    } catch (emailError) {
      this.log.error(
        { error: emailError.message, envelopeId },
        'Failed to send alert email'
      );
      return false;
    }
  }

  /**
   * Format email body HTML
   */
  formatEmailBody(error, context) {
    const dashboardUrl = `${this.config.baseUrl}/dashboard?jobId=${context.jobId}&api_key=${this.config.apiKey}`;

    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #dc3545; color: white; padding: 15px; border-radius: 5px 5px 0 0; }
    .content { background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
    .field { margin-bottom: 10px; }
    .field-label { font-weight: bold; color: #666; }
    .field-value { margin-left: 10px; }
    .stack-trace { background: #333; color: #f8f8f8; padding: 15px; font-family: monospace; font-size: 12px; overflow-x: auto; white-space: pre-wrap; border-radius: 5px; }
    .button { display: inline-block; background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 15px; }
    .footer { margin-top: 20px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">DocuSign Integration Error</h2>
    </div>
    <div class="content">
      <div class="field">
        <span class="field-label">Error Type:</span>
        <span class="field-value">${escapeHtml(error.type)}</span>
      </div>
      <div class="field">
        <span class="field-label">Job ID:</span>
        <span class="field-value">${escapeHtml(context.jobId || 'N/A')}</span>
      </div>
      <div class="field">
        <span class="field-label">Envelope ID:</span>
        <span class="field-value">${escapeHtml(context.envelopeId || 'N/A')}</span>
      </div>
      <div class="field">
        <span class="field-label">Timestamp:</span>
        <span class="field-value">${new Date().toISOString()}</span>
      </div>
      <div class="field">
        <span class="field-label">Description:</span>
        <p style="margin: 5px 0;">${escapeHtml(error.message)}</p>
      </div>

      ${error.stack ? `
      <div class="field">
        <span class="field-label">Stack Trace:</span>
        <div class="stack-trace">${escapeHtml(error.stack)}</div>
      </div>
      ` : ''}

      <a href="${dashboardUrl}" class="button">View in Dashboard</a>
    </div>
    <div class="footer">
      <p>This is an automated alert from the DocuSign Integration Layer.</p>
      <p>Alert rate limited to 1 email per envelope per error type per 15 minutes.</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  /**
   * Verify SMTP connection
   *
   * @returns {boolean} - True if connection is working
   */
  async verifyConnection() {
    try {
      await this.transporter.verify();
      this.log.info('SMTP connection verified');
      return true;
    } catch (error) {
      this.log.error({ error: error.message }, 'SMTP connection verification failed');
      return false;
    }
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Singleton instance
let instance = null;

function getInstance(config) {
  if (!instance) {
    instance = new AlertService(config);
  }
  return instance;
}

module.exports = {
  AlertService,
  getInstance
};
