const pino = require('pino');

// PII fields that should be masked in logs
const PII_FIELDS = [
  'email',
  'phone',
  'fullName',
  'customer_email',
  'customer_name',
  'customerEmail',
  'customerName',
  'transferorName'
];

/**
 * Mask a string value, keeping only first 3 characters
 */
function maskValue(value) {
  if (typeof value !== 'string' || value.length <= 3) {
    return '***';
  }
  return value.substring(0, 3) + '***';
}

/**
 * Recursively mask PII fields in an object
 */
function maskPII(obj, seen = new WeakSet()) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  // Handle circular references
  if (seen.has(obj)) {
    return '[Circular]';
  }
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map(item => maskPII(item, seen));
  }

  const masked = {};
  for (const [key, value] of Object.entries(obj)) {
    if (PII_FIELDS.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
      masked[key] = maskValue(value);
    } else if (typeof value === 'object' && value !== null) {
      masked[key] = maskPII(value, seen);
    } else {
      masked[key] = value;
    }
  }

  return masked;
}

/**
 * Create the logger instance
 * Log level is set from environment variable (default: info)
 */
function createLogger() {
  const level = process.env.LOG_LEVEL || 'info';

  return pino({
    level,
    formatters: {
      level: (label) => ({ level: label })
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Don't pretty print in production
    ...(process.env.NODE_ENV !== 'production' && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname'
        }
      }
    })
  });
}

// Try to create logger, fallback to basic if pino-pretty not installed
let logger;
try {
  logger = createLogger();
} catch (error) {
  // Fallback without pretty printing
  logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label) => ({ level: label })
    },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}

module.exports = {
  logger,
  maskPII,
  maskValue
};
