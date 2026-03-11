const docusign = require('docusign-esign');
const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

class DocuSignService {
  constructor(config) {
    this.config = config;
    this.apiClient = new docusign.ApiClient();
    this.apiClient.setBasePath(config.docusign.baseUrl);
    this.accessToken = null;
    this.tokenExpiresAt = null;
    this.log = logger.child({ service: 'docusign' });
  }

  /**
   * Authenticate with DocuSign using JWT Grant
   * Caches access token until expiration
   */
  async authenticate() {
    // Return cached token if still valid (with 60s buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    this.log.info('Authenticating with DocuSign...');

    try {
      // Read RSA private key
      const privateKeyPath = this.config.docusign.privateKeyPath;
      if (!fs.existsSync(privateKeyPath)) {
        throw new Error(`DocuSign private key not found at: ${privateKeyPath}`);
      }
      const privateKey = fs.readFileSync(privateKeyPath, 'utf-8');

      // Determine OAuth base path
      const oAuthBasePath = this.config.docusign.baseUrl.includes('demo')
        ? 'account-d.docusign.com'
        : 'account.docusign.com';

      this.apiClient.setOAuthBasePath(oAuthBasePath);

      // Request JWT token
      const results = await this.apiClient.requestJWTUserToken(
        this.config.docusign.clientId,
        this.config.docusign.userId,
        ['signature', 'impersonation'],
        privateKey,
        3600 // 1 hour expiration
      );

      this.accessToken = results.body.access_token;
      this.tokenExpiresAt = Date.now() + (results.body.expires_in * 1000);

      // Set authorization header
      this.apiClient.addDefaultHeader('Authorization', `Bearer ${this.accessToken}`);

      this.log.info('DocuSign authentication successful');
      return this.accessToken;
    } catch (error) {
      this.log.error({
        error: error.message,
        status: error.status,
        response: error.response?.body,
        hint: 'Check: 1) RSA key matches DocuSign, 2) User granted consent, 3) Client/User IDs are correct'
      }, 'DocuSign authentication failed');
      throw error;
    }
  }

  /**
   * Create an envelope from a template with populated tabs
   *
   * @param {Object} data - Request data with customer, property, and transfer info
   * @returns {string} - DocuSign envelope ID
   */
  async createEnvelopeFromTemplate(data) {
    await this.authenticate();

    const ownerFullName = [data.owner.firstName, data.owner.middleName, data.owner.lastName]
      .filter(Boolean)
      .join(' ');

    this.log.info({ ownerEmail: data.owner.email }, 'Creating envelope from template');

    const envelopesApi = new docusign.EnvelopesApi(this.apiClient);

    // Build text tabs for pre-filling
    const textTabs = [
      { tabLabel: 'ownerFirstName', value: data.owner.firstName || '' },
      { tabLabel: 'ownerMiddleName', value: data.owner.middleName || '' },
      { tabLabel: 'ownerLastName', value: data.owner.lastName || '' },
      { tabLabel: 'ownerPhone', value: data.owner.phone || '' },
      { tabLabel: 'ownerEmail', value: data.owner.email || '' },
      { tabLabel: 'ownerAddress', value: data.owner.address || '' }
    ];

    // Create envelope definition
    const envelopeDefinition = {
      templateId: this.config.docusign.templateId,
      status: 'sent', // Send immediately
      templateRoles: [{
        email: data.owner.email,
        name: ownerFullName,
        roleName: 'Owner', // Must match role name in template
        tabs: {
          textTabs
        }
      }]
    };

    try {
      const result = await envelopesApi.createEnvelope(
        this.config.docusign.accountId,
        { envelopeDefinition }
      );

      this.log.info(
        { envelopeId: result.envelopeId, status: result.status },
        'Envelope created successfully'
      );

      return result.envelopeId;
    } catch (error) {
      this.log.error({
        error: error.message,
        status: error.status,
        response: error.response?.body
      }, 'Failed to create envelope');
      throw error;
    }
  }

  /**
   * Get envelope status
   *
   * @param {string} envelopeId - DocuSign envelope ID
   * @returns {Object} - Envelope status information
   */
  async getEnvelopeStatus(envelopeId) {
    await this.authenticate();

    const envelopesApi = new docusign.EnvelopesApi(this.apiClient);

    try {
      const envelope = await envelopesApi.getEnvelope(
        this.config.docusign.accountId,
        envelopeId
      );

      return {
        envelopeId: envelope.envelopeId,
        status: envelope.status,
        statusChangedDateTime: envelope.statusChangedDateTime,
        completedDateTime: envelope.completedDateTime
      };
    } catch (error) {
      this.log.error({ envelopeId, error: error.message }, 'Failed to get envelope status');
      throw error;
    }
  }

  /**
   * Retrieve tab values from a completed envelope
   *
   * @param {string} envelopeId - DocuSign envelope ID
   * @returns {Object} - Tab label to value mapping
   */
  async getEnvelopeTabs(envelopeId) {
    await this.authenticate();

    this.log.info({ envelopeId }, 'Retrieving envelope tabs');

    const envelopesApi = new docusign.EnvelopesApi(this.apiClient);

    try {
      // Get recipients
      const recipients = await envelopesApi.listRecipients(
        this.config.docusign.accountId,
        envelopeId
      );

      const allTabs = {};

      // Get tabs for each signer
      for (const signer of recipients.signers || []) {
        const tabs = await envelopesApi.listTabs(
          this.config.docusign.accountId,
          envelopeId,
          signer.recipientId
        );

        // Flatten all tab types into a single object
        Object.assign(allTabs, this.flattenTabs(tabs));
      }

      this.log.info({ envelopeId, tabCount: Object.keys(allTabs).length }, 'Retrieved envelope tabs');
      return allTabs;
    } catch (error) {
      this.log.error({ envelopeId, error: error.message }, 'Failed to retrieve envelope tabs');
      throw error;
    }
  }

  /**
   * Flatten tab objects into a label -> value map
   */
  flattenTabs(tabs) {
    const result = {};
    const tabTypes = ['textTabs', 'dateTabs', 'numberTabs', 'currencyTabs', 'checkboxTabs'];

    for (const type of tabTypes) {
      if (tabs[type]) {
        for (const tab of tabs[type]) {
          if (tab.tabLabel) {
            result[tab.tabLabel] = tab.value || tab.selected || '';
          }
        }
      }
    }

    return result;
  }

  /**
   * Download signed document from completed envelope
   *
   * @param {string} envelopeId - DocuSign envelope ID
   * @param {string} outputPath - Local path to save the PDF
   * @returns {string} - Path to saved document
   */
  async downloadSignedDocument(envelopeId, outputPath) {
    await this.authenticate();

    this.log.info({ envelopeId, outputPath }, 'Downloading signed document');

    const envelopesApi = new docusign.EnvelopesApi(this.apiClient);

    try {
      // Ensure output directory exists
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // Download combined document (all documents in envelope as single PDF)
      const documentBuffer = await envelopesApi.getDocument(
        this.config.docusign.accountId,
        envelopeId,
        'combined'
      );

      // Write to file
      fs.writeFileSync(outputPath, documentBuffer, 'binary');

      this.log.info({ envelopeId, outputPath }, 'Document downloaded successfully');
      return outputPath;
    } catch (error) {
      this.log.error({ envelopeId, error: error.message }, 'Failed to download document');
      throw error;
    }
  }

  /**
   * Void an envelope
   *
   * @param {string} envelopeId - DocuSign envelope ID
   * @param {string} reason - Reason for voiding
   */
  async voidEnvelope(envelopeId, reason = 'Cancelled by system') {
    await this.authenticate();

    const envelopesApi = new docusign.EnvelopesApi(this.apiClient);

    try {
      await envelopesApi.update(
        this.config.docusign.accountId,
        envelopeId,
        {
          envelope: {
            status: 'voided',
            voidedReason: reason
          }
        }
      );

      this.log.info({ envelopeId, reason }, 'Envelope voided');
    } catch (error) {
      this.log.error({ envelopeId, error: error.message }, 'Failed to void envelope');
      throw error;
    }
  }
}

// Singleton instance
let instance = null;

function getInstance(config) {
  if (!instance) {
    instance = new DocuSignService(config);
  }
  return instance;
}

module.exports = {
  DocuSignService,
  getInstance
};
