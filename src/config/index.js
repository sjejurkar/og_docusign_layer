const { z } = require('zod');
const path = require('path');

// Load environment variables
require('dotenv').config();

// Configuration schema with Zod validation
const configSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().min(1).max(65535).default(3000),
  apiKey: z.string().min(10, 'API_KEY must be at least 10 characters'),

  docusign: z.object({
    accountId: z.string().min(1, 'DOCUSIGN_ACCOUNT_ID is required'),
    clientId: z.string().min(1, 'DOCUSIGN_CLIENT_ID is required'),
    userId: z.string().min(1, 'DOCUSIGN_USER_ID is required'),
    privateKeyPath: z.string().optional(),
    privateKey: z.string().optional(),
    baseUrl: z.string().url('DOCUSIGN_BASE_URL must be a valid URL'),
    templateId: z.string().min(1, 'DOCUSIGN_TEMPLATE_ID is required'),
    hmacKey: z.string().min(10, 'DOCUSIGN_HMAC_KEY must be at least 10 characters')
  }).refine(
    data => data.privateKey || data.privateKeyPath,
    { message: 'Either DOCUSIGN_PRIVATE_KEY or DOCUSIGN_PRIVATE_KEY_PATH is required' }
  ),

  downstream: z.object({
    apiUrl: z.string().url('DOWNSTREAM_API_URL must be a valid URL'),
    apiKey: z.string().min(1, 'DOWNSTREAM_API_KEY is required')
  }),

  alert: z.object({
    email: z.string().email('ALERT_EMAIL must be a valid email address')
  }),

  smtp: z.object({
    host: z.string().min(1, 'SMTP_HOST is required'),
    port: z.coerce.number().min(1).max(65535),
    user: z.string().min(1, 'SMTP_USER is required'),
    pass: z.string().min(1, 'SMTP_PASS is required')
  }),

  supabase: z.object({
    url: z.string().url('SUPABASE_URL must be a valid URL'),
    anonKey: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
    serviceRoleKey: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required')
  }),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  signedDocsPath: z.string().default('./storage/signed')
});

// Map environment variables to config object
const rawConfig = {
  nodeEnv: process.env.NODE_ENV,
  port: process.env.PORT,
  apiKey: process.env.API_KEY,

  docusign: {
    accountId: process.env.DOCUSIGN_ACCOUNT_ID,
    clientId: process.env.DOCUSIGN_CLIENT_ID,
    userId: process.env.DOCUSIGN_USER_ID,
    privateKeyPath: process.env.DOCUSIGN_PRIVATE_KEY_PATH,
    privateKey: process.env.DOCUSIGN_PRIVATE_KEY,
    baseUrl: process.env.DOCUSIGN_BASE_URL,
    templateId: process.env.DOCUSIGN_TEMPLATE_ID,
    hmacKey: process.env.DOCUSIGN_HMAC_KEY
  },

  downstream: {
    apiUrl: process.env.DOWNSTREAM_API_URL,
    apiKey: process.env.DOWNSTREAM_API_KEY
  },

  alert: {
    email: process.env.ALERT_EMAIL
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },

  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  },
  logLevel: process.env.LOG_LEVEL,
  signedDocsPath: process.env.SIGNED_DOCS_PATH
};

// Validate configuration
let config;
try {
  config = configSchema.parse(rawConfig);

  // Resolve relative paths to absolute
  if (config.docusign.privateKeyPath && !path.isAbsolute(config.docusign.privateKeyPath)) {
    config.docusign.privateKeyPath = path.resolve(process.cwd(), config.docusign.privateKeyPath);
  }
  if (!path.isAbsolute(config.signedDocsPath)) {
    config.signedDocsPath = path.resolve(process.cwd(), config.signedDocsPath);
  }

} catch (error) {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    console.error('Configuration validation failed:\n' + issues);
    process.exit(1);
  }
  throw error;
}

// Compute base URL for the application (used in email links)
config.baseUrl = process.env.BASE_URL || `http://localhost:${config.port}`;

module.exports = config;
