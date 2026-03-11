const { z } = require('zod');
const { logger } = require('../utils/logger');

// Schema for validating extracted data
const extractedDataSchema = z.object({
  jobId: z.string(),
  envelopeId: z.string(),
  signedAt: z.string(),
  owner: z.object({
    firstName: z.string().min(1, 'Owner first name is required'),
    middleName: z.string().nullable(),
    lastName: z.string().min(1, 'Owner last name is required'),
    phone: z.string().nullable(),
    email: z.string().email('Owner email is required'),
    address: z.string().min(1, 'Owner address is required')
  }),
  documentUrl: z.string()
});

// Mapping from DocuSign tab labels to canonical field paths
const TAB_MAPPING = {
  ownerFirstName: 'owner.firstName',
  ownerMiddleName: 'owner.middleName',
  ownerLastName: 'owner.lastName',
  ownerPhone: 'owner.phone',
  ownerEmail: 'owner.email',
  ownerAddress: 'owner.address'
};

/**
 * Extract data from DocuSign tabs into canonical model
 *
 * @param {Object} tabs - Tab label to value mapping from DocuSign
 * @param {Object} envelopeInfo - Envelope metadata (jobId, envelopeId, completedAt)
 * @returns {Object} - Extracted canonical data payload
 * @throws {Error} - If validation fails
 */
function extractData(tabs, envelopeInfo) {
  const log = logger.child({
    service: 'extractor',
    jobId: envelopeInfo.jobId,
    envelopeId: envelopeInfo.envelopeId
  });

  log.info('Extracting data from envelope tabs');

  // Build extracted data object
  const extracted = {
    jobId: envelopeInfo.jobId,
    envelopeId: envelopeInfo.envelopeId,
    signedAt: envelopeInfo.completedAt || new Date().toISOString(),
    owner: {
      firstName: tabs.ownerFirstName || '',
      middleName: tabs.ownerMiddleName || null,
      lastName: tabs.ownerLastName || '',
      phone: tabs.ownerPhone || null,
      email: tabs.ownerEmail || '',
      address: tabs.ownerAddress || ''
    },
    documentUrl: `/api/v1/envelopes/${envelopeInfo.jobId}/document`
  };

  // Handle empty optional fields as null
  if (extracted.owner.middleName === '') {
    extracted.owner.middleName = null;
  }
  if (extracted.owner.phone === '') {
    extracted.owner.phone = null;
  }

  // Validate extracted data
  const validation = extractedDataSchema.safeParse(extracted);

  if (!validation.success) {
    const issues = validation.error.issues.map(issue =>
      `${issue.path.join('.')}: ${issue.message}`
    ).join(', ');

    log.error({ issues }, 'Extraction validation failed');
    throw new Error(`Extraction validation failed: ${issues}`);
  }

  log.info('Data extraction successful');
  return validation.data;
}

/**
 * Validate that all required tabs are present
 *
 * @param {Object} tabs - Tab label to value mapping
 * @returns {Object} - Validation result { valid: boolean, missing: string[] }
 */
function validateTabs(tabs) {
  const requiredTabs = [
    'ownerFirstName',
    'ownerLastName',
    'ownerEmail',
    'ownerAddress'
  ];

  const missing = requiredTabs.filter(tab => !tabs[tab] || tabs[tab].trim() === '');

  return {
    valid: missing.length === 0,
    missing
  };
}

/**
 * Get tab label for a canonical field path
 *
 * @param {string} fieldPath - Dot-notation field path (e.g., 'customer.fullName')
 * @returns {string|null} - DocuSign tab label or null if not found
 */
function getTabLabel(fieldPath) {
  for (const [tabLabel, path] of Object.entries(TAB_MAPPING)) {
    if (path === fieldPath) {
      return tabLabel;
    }
  }
  return null;
}

module.exports = {
  extractData,
  validateTabs,
  getTabLabel,
  TAB_MAPPING,
  extractedDataSchema
};
