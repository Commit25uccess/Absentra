/**
 * Input Sanitization Utility
 * Provides consistent input validation, sanitization, and security checks
 */

import logger, { generateRequestId, runWithContextAsync } from './logger';

/* ------------------------------------------------------------------ */
/* Types and Interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface SanitizationOptions {
  trim?: boolean;
  lowercase?: boolean;
  uppercase?: boolean;
  removeHtml?: boolean;
  removeScripts?: boolean;
  sanitizeSql?: boolean;
  maxLength?: number;
  minLength?: number;
  allowedChars?: RegExp;
  forbiddenChars?: RegExp;
  allowedTags?: string[];
  allowEmpty?: boolean;
  normalizeWhitespace?: boolean;
  removeUrls?: boolean;
  removeEmails?: boolean;
  escapeHtml?: boolean;
  customSanitizers?: Array<(value: string) => string>;
}

export interface SanitizationResult {
  success: boolean;
  sanitized: string;
  original: string;
  warnings: string[];
  errors: string[];
  metadata: {
    hasHtml: boolean;
    hasScripts: boolean;
    hasSql: boolean;
    hasUrls: boolean;
    hasEmails: boolean;
    charCount: number;
    wordCount: number;
    lineCount: number;
  };
}

export interface ValidationRule {
  name: string;
  validate: (value: string) => boolean | string;
  message?: string;
  required?: boolean;
}

export interface SanitizationSchema {
  [fieldName: string]: {
    rules: ValidationRule[];
    options?: SanitizationOptions;
    required?: boolean;
    defaultValue?: any;
  };
}

/* ------------------------------------------------------------------ */
/* Default Sanitization Options                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_OPTIONS: Required<Omit<SanitizationOptions, 'customSanitizers' | 'allowedTags'>> & {
  customSanitizers: Array<(value: string) => string>;
  allowedTags: string[];
} = {
  trim: true,
  lowercase: false,
  uppercase: false,
  removeHtml: false,
  removeScripts: true,
  sanitizeSql: true,
  maxLength: 10000,
  minLength: 0,
  allowedChars: null as any,
  forbiddenChars: null as any,
  allowedTags: [],
  allowEmpty: true,
  normalizeWhitespace: true,
  removeUrls: false,
  removeEmails: false,
  escapeHtml: false,
  customSanitizers: [],
};

/* ------------------------------------------------------------------ */
/* Security Patterns                                                       */
/* ------------------------------------------------------------------ */

const SECURITY_PATTERNS = {
  // HTML patterns
  htmlTags: /<[^>]*>/g,
  htmlAttributes: /\s*[a-z-]+=(?:"[^"]*"|'[^']*'|[^>\s]*)/gi,
  
  // Script patterns
  scriptTags: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  javascript: /javascript:/gi,
  onEventHandlers: /\s+on\w+\s*=/gi,
  
  // SQL injection patterns
  sqlKeywords: /\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b/gi,
  sqlChars: /['";\\]/g,
  
  // URL patterns
  urls: /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g,
  
  // Email patterns
  emails: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  
  // XSS patterns
  xssPatterns: [
    /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
    /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
    /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi,
    /<link\b[^>]*>/gi,
    /<meta\b[^>]*>/gi,
  ],
  
  // Control characters
  controlChars: /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
  
  // Unicode exploits
  unicodeExploits: /[\u202E\u200E\u200F\u202A\u202B\u202C\u202D]/g,
};

/* ------------------------------------------------------------------ */
/* Core Sanitization Functions                                           */
/* ------------------------------------------------------------------ */

export class InputSanitizer {
  private static requestIdCounter = 0;

  /**
   * Sanitize input string with comprehensive security checks
   */
  static async sanitize(input: any, options: SanitizationOptions = {}): Promise<SanitizationResult> {
    const requestId = generateRequestId();
    this.requestIdCounter++;

    return await runWithContextAsync(
      { requestId, type: 'sanitization' as any, name: 'input_sanitize' },
      async () => {
        const startTime = Date.now();
        
        // Convert input to string
        const original = String(input || '');
        let sanitized = original;
        const warnings: string[] = [];
        const errors: string[] = [];

        // Merge with default options
        const finalOptions = { ...DEFAULT_OPTIONS, ...options };
        
        // Create metadata
        const metadata = this.createMetadata(original);

        try {
          // Basic text normalization
          sanitized = this.applyBasicNormalization(sanitized, finalOptions);
          
          // Security sanitization
          sanitized = this.applySecuritySanitization(sanitized, finalOptions, metadata, warnings);
          
          // Content filtering
          sanitized = this.applyContentFiltering(sanitized, finalOptions, metadata, warnings);
          
          // Length validation
          this.validateLength(sanitized, finalOptions, errors);
          
          // Character validation
          this.validateCharacters(sanitized, finalOptions, errors);
          
          // Empty value validation
          this.validateEmpty(sanitized, finalOptions, errors);
          
          // Apply custom sanitizers
          sanitized = this.applyCustomSanitizers(sanitized, finalOptions, warnings);
          
          // Update metadata for final result
          const finalMetadata = this.createMetadata(sanitized);

          const result: SanitizationResult = {
            success: errors.length === 0,
            sanitized,
            original,
            warnings,
            errors,
            metadata: finalMetadata,
          };

          logger.debug({
            event: 'sanitization_completed',
            requestId,
            success: result.success,
            originalLength: original.length,
            sanitizedLength: sanitized.length,
            warnings: warnings.length,
            errors: errors.length,
            duration: Date.now() - startTime,
          });

          return result;

        } catch (error) {
          errors.push(`Sanitization failed: ${error instanceof Error ? error.message : String(error)}`);

          logger.error({ event: 'sanitization_failed', requestId, inputLength: original.length }, error);

          return {
            success: false,
            sanitized: '',
            original,
            warnings,
            errors,
            metadata: this.createMetadata(''),
          };
        }
      }
    );
  }

  /**
   * Validate input against schema
   */
  static async validateSchema(
    data: Record<string, any>,
    schema: SanitizationSchema
  ): Promise<{ success: boolean; errors: Record<string, string[]>; sanitized: Record<string, any> }> {
    const requestId = generateRequestId();
    
    return await runWithContextAsync(
      { requestId, type: 'sanitization' as any, name: 'schema_validate' },
      async () => {
        const errors: Record<string, string[]> = {};
        const sanitized: Record<string, any> = {};

        for (const [fieldName, fieldConfig] of Object.entries(schema)) {
          const value = data[fieldName];
          const fieldErrors: string[] = [];

          // Check if required field is missing
          if (fieldConfig.required && (value === undefined || value === null || value === '')) {
            fieldErrors.push(`${fieldName} is required`);
            errors[fieldName] = fieldErrors;
            
            // Use default value if available
            if (fieldConfig.defaultValue !== undefined) {
              sanitized[fieldName] = fieldConfig.defaultValue;
            }
            continue;
          }

          // Skip sanitization for empty optional fields
          if (!fieldConfig.required && (value === undefined || value === null || value === '')) {
            sanitized[fieldName] = fieldConfig.defaultValue || '';
            continue;
          }

          // Sanitize the value
          const sanitizationResult = await this.sanitize(value, fieldConfig.options);
          
          if (!sanitizationResult.success) {
            fieldErrors.push(...sanitizationResult.errors);
          }

          // Apply validation rules
          for (const rule of fieldConfig.rules) {
            const validationResult = rule.validate(sanitizationResult.sanitized);
            
            if (validationResult !== true) {
              const message = validationResult || rule.message || `Validation failed for ${rule.name}`;
              fieldErrors.push(message);
            }
          }

          // Store sanitized value if no errors
          if (fieldErrors.length === 0) {
            sanitized[fieldName] = sanitizationResult.sanitized;
          } else {
            errors[fieldName] = fieldErrors;
          }

          // Add sanitization warnings to field errors
          if (sanitizationResult.warnings.length > 0) {
            fieldErrors.push(...sanitizationResult.warnings);
            if (!errors[fieldName]) {
              errors[fieldName] = fieldErrors;
            }
          }
        }

        const success = Object.keys(errors).length === 0;

        logger.debug({
          event: 'schema_validation_completed',
          requestId,
          success,
          fieldsProcessed: Object.keys(schema).length,
          fieldErrors: Object.keys(errors).length,
        });

        return { success, errors, sanitized };
      }
    );
  }

  /**
   * Create metadata for the input
   */
  private static createMetadata(input: string) {
    return {
      hasHtml: SECURITY_PATTERNS.htmlTags.test(input),
      hasScripts: SECURITY_PATTERNS.scriptTags.test(input) || SECURITY_PATTERNS.javascript.test(input),
      hasSql: SECURITY_PATTERNS.sqlKeywords.test(input),
      hasUrls: SECURITY_PATTERNS.urls.test(input),
      hasEmails: SECURITY_PATTERNS.emails.test(input),
      charCount: input.length,
      wordCount: input.trim().split(/\s+/).filter(word => word.length > 0).length,
      lineCount: input.split('\n').length,
    };
  }

  /**
   * Apply basic text normalization
   */
  private static applyBasicNormalization(input: string, options: Required<SanitizationOptions>): string {
    let result = input;

    // Trim whitespace
    if (options.trim) {
      result = result.trim();
    }

    // Normalize whitespace
    if (options.normalizeWhitespace) {
      result = result.replace(/\s+/g, ' ');
    }

    // Case conversion
    if (options.lowercase && !options.uppercase) {
      result = result.toLowerCase();
    } else if (options.uppercase && !options.lowercase) {
      result = result.toUpperCase();
    }

    return result;
  }

  /**
   * Apply security sanitization
   */
  private static applySecuritySanitization(
    input: string,
    options: Required<SanitizationOptions>,
    metadata: any,
    warnings: string[]
  ): string {
    let result = input;

    // Remove script tags and JavaScript
    if (options.removeScripts || metadata.hasScripts) {
      result = result.replace(SECURITY_PATTERNS.scriptTags, '');
      result = result.replace(SECURITY_PATTERNS.javascript, '');
      result = result.replace(SECURITY_PATTERNS.onEventHandlers, '');
      
      if (metadata.hasScripts) {
        warnings.push('JavaScript code detected and removed');
      }
    }

    // Remove HTML tags
    if (options.removeHtml || metadata.hasHtml) {
      result = result.replace(SECURITY_PATTERNS.htmlTags, '');
      result = result.replace(SECURITY_PATTERNS.htmlAttributes, '');
      
      if (metadata.hasHtml) {
        warnings.push('HTML tags detected and removed');
      }
    }

    // Escape HTML entities
    if (options.escapeHtml) {
      result = result
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, '&#x27;');
    }

    // Sanitize SQL injection attempts
    if (options.sanitizeSql || metadata.hasSql) {
      result = result.replace(SECURITY_PATTERNS.sqlKeywords, '');
      result = result.replace(SECURITY_PATTERNS.sqlChars, '');
      
      if (metadata.hasSql) {
        warnings.push('Potential SQL injection detected and sanitized');
      }
    }

    // Remove XSS patterns
    for (const pattern of SECURITY_PATTERNS.xssPatterns) {
      result = result.replace(pattern, '');
    }

    // Remove control characters
    result = result.replace(SECURITY_PATTERNS.controlChars, '');

    // Remove Unicode exploits
    result = result.replace(SECURITY_PATTERNS.unicodeExploits, '');

    return result;
  }

  /**
   * Apply content filtering
   */
  private static applyContentFiltering(
    input: string,
    options: Required<SanitizationOptions>,
    metadata: any,
    warnings: string[]
  ): string {
    let result = input;

    // Remove URLs
    if (options.removeUrls || metadata.hasUrls) {
      result = result.replace(SECURITY_PATTERNS.urls, '');
      
      if (metadata.hasUrls) {
        warnings.push('URLs detected and removed');
      }
    }

    // Remove email addresses
    if (options.removeEmails || metadata.hasEmails) {
      result = result.replace(SECURITY_PATTERNS.emails, '[email-redacted]');
      
      if (metadata.hasEmails) {
        warnings.push('Email addresses detected and redacted');
      }
    }

    return result;
  }

  /**
   * Validate input length
   */
  private static validateLength(input: string, options: Required<SanitizationOptions>, errors: string[]): void {
    if (input.length < options.minLength) {
      errors.push(`Input must be at least ${options.minLength} characters long`);
    }

    if (input.length > options.maxLength) {
      errors.push(`Input must not exceed ${options.maxLength} characters`);
    }
  }

  /**
   * Validate character sets
   */
  private static validateCharacters(input: string, options: Required<SanitizationOptions>, errors: string[]): void {
    if (options.allowedChars && !options.allowedChars.test(input)) {
      errors.push('Input contains invalid characters');
    }

    if (options.forbiddenChars && options.forbiddenChars.test(input)) {
      errors.push('Input contains forbidden characters');
    }
  }

  /**
   * Validate empty input
   */
  private static validateEmpty(input: string, options: Required<SanitizationOptions>, errors: string[]): void {
    if (!options.allowEmpty && input.trim().length === 0) {
      errors.push('Input cannot be empty');
    }
  }

  /**
   * Apply custom sanitizers
   */
  private static applyCustomSanitizers(
    input: string,
    options: Required<SanitizationOptions>,
    warnings: string[]
  ): string {
    let result = input;

    for (const sanitizer of options.customSanitizers) {
      try {
        const originalValue = result;
        result = sanitizer(result);
        
        if (result !== originalValue) {
          warnings.push(`Custom sanitizer modified the input`);
        }
      } catch (error) {
        warnings.push(`Custom sanitizer failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return result;
  }

  /* ------------------------------------------------------------------ */
  /* Predefined Sanitization Options                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Strict sanitization for user input
   */
  static get STRICT_OPTIONS(): SanitizationOptions {
    return {
      trim: true,
      normalizeWhitespace: true,
      removeHtml: true,
      removeScripts: true,
      sanitizeSql: true,
      maxLength: 1000,
      minLength: 1,
      allowEmpty: false,
      escapeHtml: true,
    };
  }

  /**
   * Sanitization for rich text content
   */
  static get RICH_TEXT_OPTIONS(): SanitizationOptions {
    return {
      trim: true,
      normalizeWhitespace: true,
      removeScripts: true,
      sanitizeSql: true,
      maxLength: 10000,
      minLength: 0,
      allowEmpty: true,
      allowedTags: ['p', 'br', 'strong', 'em', 'u', 'ol', 'ul', 'li'],
    };
  }

  /**
   * Sanitization for usernames and identifiers
   */
  static get USERNAME_OPTIONS(): SanitizationOptions {
    return {
      trim: true,
      lowercase: true,
      normalizeWhitespace: true,
      removeHtml: true,
      removeScripts: true,
      sanitizeSql: true,
      maxLength: 50,
      minLength: 3,
      allowEmpty: false,
      allowedChars: /^[a-zA-Z0-9_-]+$/,
    };
  }

  /**
   * Sanitization for email addresses
   */
  static get EMAIL_OPTIONS(): SanitizationOptions {
    return {
      trim: true,
      lowercase: true,
      removeHtml: true,
      removeScripts: true,
      sanitizeSql: true,
      maxLength: 254,
      minLength: 5,
      allowEmpty: false,
      allowedChars: /^[a-zA-Z0-9._%+-@]+$/,
    };
  }

  /**
   * Sanitization for numbers and numeric input
   */
  static get NUMERIC_OPTIONS(): SanitizationOptions {
    return {
      trim: true,
      removeHtml: true,
      removeScripts: true,
      sanitizeSql: true,
      maxLength: 20,
      minLength: 1,
      allowEmpty: false,
      allowedChars: /^[0-9.-]+$/,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Validation Rules                                                       */
/* ------------------------------------------------------------------ */

export const CommonValidationRules = {
  /**
   * Validate email format
   */
  email: {
    name: 'email',
    validate: (value: string) => {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailPattern.test(value) || 'Invalid email format';
    },
  },

  /**
   * Validate username format
   */
  username: {
    name: 'username',
    validate: (value: string) => {
      const usernamePattern = /^[a-zA-Z0-9_-]{3,50}$/;
      return usernamePattern.test(value) || 'Username must be 3-50 characters, alphanumeric, underscore, or hyphen only';
    },
  },

  /**
   * Validate strong password
   */
  strongPassword: {
    name: 'strongPassword',
    validate: (value: string) => {
      if (value.length < 8) return 'Password must be at least 8 characters long';
      if (!/[a-z]/.test(value)) return 'Password must contain at least one lowercase letter';
      if (!/[A-Z]/.test(value)) return 'Password must contain at least one uppercase letter';
      if (!/[0-9]/.test(value)) return 'Password must contain at least one number';
      if (!/[!@#$%^&*(),.?":{}|<>]/.test(value)) return 'Password must contain at least one special character';
      return true;
    },
  },

  /**
   * Validate phone number
   */
  phone: {
    name: 'phone',
    validate: (value: string) => {
      const phonePattern = /^\+?[\d\s\-\(\)]+$/;
      return phonePattern.test(value) || 'Invalid phone number format';
    },
  },

  /**
   * Validate date format
   */
  date: {
    name: 'date',
    validate: (value: string) => {
      const date = new Date(value);
      return !isNaN(date.getTime()) || 'Invalid date format';
    },
  },

  /**
   * Validate positive number
   */
  positiveNumber: {
    name: 'positiveNumber',
    validate: (value: string) => {
      const num = parseFloat(value);
      return !isNaN(num) && num > 0 || 'Must be a positive number';
    },
  },

  /**
   * Validate non-empty string
   */
  nonEmpty: {
    name: 'nonEmpty',
    validate: (value: string) => {
      return value.trim().length > 0 || 'Field cannot be empty';
    },
  },
};

/* ------------------------------------------------------------------ */
/* Exports                                                               */
/* ------------------------------------------------------------------ */
