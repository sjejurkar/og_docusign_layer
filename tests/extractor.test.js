const { extractData, validateTabs, TAB_MAPPING } = require('../src/services/extractorService');

describe('ExtractorService', () => {
  // Sample valid tabs from DocuSign
  const validTabs = {
    ownerFirstName: 'John',
    ownerMiddleName: 'Robert',
    ownerLastName: 'Doe',
    ownerPhone: '555-123-4567',
    ownerEmail: 'john.doe@example.com',
    ownerAddress: '123 Main Street, Springfield, IL 62701'
  };

  const envelopeInfo = {
    jobId: 'job-123-456-789',
    envelopeId: 'env-abc-def-ghi',
    completedAt: '2024-03-15T14:30:00.000Z'
  };

  describe('extractData', () => {
    test('extracts all required fields from valid tabs', () => {
      const result = extractData(validTabs, envelopeInfo);

      expect(result.jobId).toBe('job-123-456-789');
      expect(result.envelopeId).toBe('env-abc-def-ghi');
      expect(result.signedAt).toBe('2024-03-15T14:30:00.000Z');

      expect(result.owner.firstName).toBe('John');
      expect(result.owner.middleName).toBe('Robert');
      expect(result.owner.lastName).toBe('Doe');
      expect(result.owner.phone).toBe('555-123-4567');
      expect(result.owner.email).toBe('john.doe@example.com');
      expect(result.owner.address).toBe('123 Main Street, Springfield, IL 62701');

      expect(result.documentUrl).toBe('/api/v1/envelopes/job-123-456-789/document');
    });

    test('handles empty phone number as null', () => {
      const tabsWithoutPhone = { ...validTabs, ownerPhone: '' };
      const result = extractData(tabsWithoutPhone, envelopeInfo);

      expect(result.owner.phone).toBeNull();
    });

    test('handles missing phone number as null', () => {
      const tabsWithoutPhone = { ...validTabs };
      delete tabsWithoutPhone.ownerPhone;
      const result = extractData(tabsWithoutPhone, envelopeInfo);

      expect(result.owner.phone).toBeNull();
    });

    test('handles empty middle name as null', () => {
      const tabsWithoutMiddle = { ...validTabs, ownerMiddleName: '' };
      const result = extractData(tabsWithoutMiddle, envelopeInfo);

      expect(result.owner.middleName).toBeNull();
    });

    test('handles missing middle name as null', () => {
      const tabsWithoutMiddle = { ...validTabs };
      delete tabsWithoutMiddle.ownerMiddleName;
      const result = extractData(tabsWithoutMiddle, envelopeInfo);

      expect(result.owner.middleName).toBeNull();
    });

    test('throws error when required firstName is missing', () => {
      const incompleteTabs = { ...validTabs };
      delete incompleteTabs.ownerFirstName;

      expect(() => extractData(incompleteTabs, envelopeInfo)).toThrow('Extraction validation failed');
    });

    test('throws error when required lastName is missing', () => {
      const incompleteTabs = { ...validTabs };
      delete incompleteTabs.ownerLastName;

      expect(() => extractData(incompleteTabs, envelopeInfo)).toThrow('Extraction validation failed');
    });

    test('throws error when required address is missing', () => {
      const incompleteTabs = { ...validTabs };
      delete incompleteTabs.ownerAddress;

      expect(() => extractData(incompleteTabs, envelopeInfo)).toThrow('Extraction validation failed');
    });

    test('throws error when email is invalid', () => {
      const invalidEmail = { ...validTabs, ownerEmail: 'not-an-email' };

      expect(() => extractData(invalidEmail, envelopeInfo)).toThrow('Extraction validation failed');
    });

    test('uses current timestamp when completedAt not provided', () => {
      const infoWithoutTimestamp = { jobId: 'job-1', envelopeId: 'env-1' };
      const result = extractData(validTabs, infoWithoutTimestamp);

      expect(result.signedAt).toBeDefined();
      expect(new Date(result.signedAt)).toBeInstanceOf(Date);
    });
  });

  describe('validateTabs', () => {
    test('returns valid for complete tabs', () => {
      const result = validateTabs(validTabs);

      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    test('returns missing fields for incomplete tabs', () => {
      const incompleteTabs = {
        ownerFirstName: 'John',
        ownerEmail: 'john@example.com'
      };

      const result = validateTabs(incompleteTabs);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain('ownerLastName');
      expect(result.missing).toContain('ownerAddress');
    });

    test('considers empty strings as missing', () => {
      const emptyTabs = { ...validTabs, ownerAddress: '   ' };
      const result = validateTabs(emptyTabs);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain('ownerAddress');
    });

    test('phone is not required', () => {
      const tabsWithoutPhone = { ...validTabs };
      delete tabsWithoutPhone.ownerPhone;

      const result = validateTabs(tabsWithoutPhone);

      expect(result.valid).toBe(true);
      expect(result.missing).not.toContain('ownerPhone');
    });

    test('middleName is not required', () => {
      const tabsWithoutMiddle = { ...validTabs };
      delete tabsWithoutMiddle.ownerMiddleName;

      const result = validateTabs(tabsWithoutMiddle);

      expect(result.valid).toBe(true);
      expect(result.missing).not.toContain('ownerMiddleName');
    });
  });

  describe('TAB_MAPPING', () => {
    test('contains all required tab mappings', () => {
      expect(TAB_MAPPING.ownerFirstName).toBe('owner.firstName');
      expect(TAB_MAPPING.ownerMiddleName).toBe('owner.middleName');
      expect(TAB_MAPPING.ownerLastName).toBe('owner.lastName');
      expect(TAB_MAPPING.ownerPhone).toBe('owner.phone');
      expect(TAB_MAPPING.ownerEmail).toBe('owner.email');
      expect(TAB_MAPPING.ownerAddress).toBe('owner.address');
    });

    test('has exactly 6 mappings', () => {
      expect(Object.keys(TAB_MAPPING)).toHaveLength(6);
    });
  });
});
