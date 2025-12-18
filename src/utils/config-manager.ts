/**
 * Configuration Manager
 * Handles configuration validation, hot-reloading, and runtime updates
 */

import logger, { generateRequestId, runWithContextAsync } from './logger';

// Node.js imports with proper typing
declare const require: (id: string) => any;
declare const process: {
  cwd: () => string;
  env: Record<string, string | undefined>;
};
declare const globalThis: any;

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* Types and Interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface ConfigSchema {
  [key: string]: ConfigValue;
}

export interface ConfigValue {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'email' | 'url' | 'port' | 'timezone';
  required?: boolean;
  default?: any;
  min?: number;
  max?: number;
  enum?: any[];
  pattern?: RegExp;
  description?: string;
  envVar?: string;
  sensitive?: boolean;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
  config: Record<string, any>;
}

export interface ConfigValidationError {
  path: string;
  value: any;
  message: string;
  code: 'required' | 'type' | 'range' | 'enum' | 'pattern' | 'custom';
}

export interface ConfigValidationWarning {
  path: string;
  value: any;
  message: string;
  code: 'deprecated' | 'default_used' | 'insecure';
}

export interface ConfigManagerOptions {
  configFile?: string;
  enableHotReload?: boolean;
  validateOnLoad?: boolean;
  enableEnvOverride?: boolean;
  encryptionKey?: string;
  backupConfig?: boolean;
}

export type ConfigChangeListener = (
  config: Record<string, any>,
  changes: ConfigChange[]
) => void | Promise<void>;

export interface ConfigChange {
  path: string;
  oldValue: any;
  newValue: any;
  type: 'added' | 'modified' | 'deleted';
}

/* ------------------------------------------------------------------ */
/* Default Configuration Schemas                                          */
/* ------------------------------------------------------------------ */

export const DEFAULT_APP_CONFIG_SCHEMA: ConfigSchema = {
  // Server Configuration
  'server.port': {
    type: 'port',
    required: true,
    default: 3000,
    description: 'Server port number',
    envVar: 'PORT',
  },
  'server.host': {
    type: 'string',
    default: 'localhost',
    description: 'Server host address',
    envVar: 'HOST',
  },

  // Database Configuration
  'database.url': {
    type: 'string',
    required: true,
    sensitive: true,
    description: 'Database connection URL',
    envVar: 'DATABASE_URL',
  },
  'database.poolMin': {
    type: 'number',
    default: 2,
    min: 1,
    description: 'Minimum database pool connections',
  },
  'database.poolMax': {
    type: 'number',
    default: 10,
    min: 1,
    description: 'Maximum database pool connections',
  },
  'database.timeoutMs': {
    type: 'number',
    default: 30000,
    min: 1000,
    description: 'Database query timeout in milliseconds',
  },

  // Slack Configuration
  'slack.botToken': {
    type: 'string',
    required: true,
    sensitive: true,
    description: 'Slack bot token',
    envVar: 'SLACK_BOT_TOKEN',
  },
  'slack.signingSecret': {
    type: 'string',
    required: true,
    sensitive: true,
    description: 'Slack signing secret',
    envVar: 'SLACK_SIGNING_SECRET',
  },
  'slack.rateLimitPerSecond': {
    type: 'number',
    default: 100,
    min: 1,
    max: 1000,
    description: 'Slack API rate limit per second',
  },

  // Cache Configuration
  'cache.maxSize': {
    type: 'number',
    default: 1000,
    min: 10,
    description: 'Maximum cache entries',
  },
  'cache.maxMemoryMb': {
    type: 'number',
    default: 50,
    min: 1,
    max: 1000,
    description: 'Maximum cache memory in MB',
  },
  'cache.ttlMinutes': {
    type: 'number',
    default: 60,
    min: 1,
    description: 'Default cache TTL in minutes',
  },

  // Job Scheduler Configuration
  'scheduler.enabled': {
    type: 'boolean',
    default: true,
    description: 'Enable job scheduler',
  },
  'scheduler.maxConcurrentJobs': {
    type: 'number',
    default: 5,
    min: 1,
    max: 50,
    description: 'Maximum concurrent jobs',
  },
  'scheduler.jobTimeoutMinutes': {
    type: 'number',
    default: 30,
    min: 1,
    description: 'Default job timeout in minutes',
  },

  // Logging Configuration
  'logging.level': {
    type: 'string',
    default: 'info',
    enum: ['error', 'warn', 'info', 'debug'],
    description: 'Logging level',
    envVar: 'LOG_LEVEL',
  },
  'logging.maxFileSize': {
    type: 'number',
    default: 10485760, // 10MB
    min: 1024,
    description: 'Maximum log file size in bytes',
  },
  'logging.maxFiles': {
    type: 'number',
    default: 5,
    min: 1,
    max: 100,
    description: 'Maximum number of log files to retain',
  },

  // Security Configuration
  'security.sessionTimeoutMinutes': {
    type: 'number',
    default: 60,
    min: 5,
    description: 'Session timeout in minutes',
  },
  'security.maxLoginAttempts': {
    type: 'number',
    default: 5,
    min: 1,
    max: 20,
    description: 'Maximum login attempts before lockout',
  },
  'security.lockoutMinutes': {
    type: 'number',
    default: 15,
    min: 1,
    description: 'Account lockout duration in minutes',
  },

  // Timezone Configuration
  'timezone.default': {
    type: 'timezone',
    default: 'UTC',
    description: 'Default timezone',
    envVar: 'TZ',
  },
};

/* ------------------------------------------------------------------ */
/* Configuration Validator                                                */
/* ------------------------------------------------------------------ */

class ConfigValidator {
  /**
   * Validate configuration against schema
   */
  static validate(
    config: Record<string, any>,
    schema: ConfigSchema,
    path = ''
  ): ConfigValidationResult {
    const errors: ConfigValidationError[] = [];
    const warnings: ConfigValidationWarning[] = [];
    const validatedConfig: Record<string, any> = {};

    for (const [key, schemaValue] of Object.entries(schema)) {
      const fullPath = path ? `${path}.${key}` : key;
      const value = config[key];

      try {
        const validationResult = this.validateValue(value, schemaValue, fullPath);
        
        if (validationResult.error) {
          errors.push(validationResult.error);
        }

        if (validationResult.warning) {
          warnings.push(validationResult.warning);
        }

        validatedConfig[key] = validationResult.value;

      } catch (error) {
        errors.push({
          path: fullPath,
          value,
          message: error instanceof Error ? error.message : String(error),
          code: 'custom',
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      config: validatedConfig,
    };
  }

  /**
   * Validate individual value
   */
  static validateValue(
    value: any,
    schema: ConfigValue,
    path: string
  ): { value: any; error?: ConfigValidationError; warning?: ConfigValidationWarning } {
    let finalValue = value;
    let error: ConfigValidationError | undefined;
    let warning: ConfigValidationWarning | undefined;

    // Check if value is provided or if default should be used
    if (value === undefined || value === null) {
      if (schema.required) {
        error = {
          path,
          value,
          message: `Required configuration value is missing`,
          code: 'required',
        };
        return { value: schema.default, error };
      } else if (schema.default !== undefined) {
        warning = {
          path,
          value: schema.default,
          message: `Using default value for ${path}`,
          code: 'default_used',
        };
        return { value: schema.default, warning };
      } else {
        return { value: undefined };
      }
    }

    // Type validation
    if (!this.isValidType(finalValue, schema.type)) {
      error = {
        path,
        value: finalValue,
        message: `Invalid type. Expected ${schema.type}, got ${typeof finalValue}`,
        code: 'type',
      };
      return { value: schema.default, error };
    }

    // Range validation for numbers
    if (schema.type === 'number') {
      if (schema.min !== undefined && finalValue < schema.min) {
        error = {
          path,
          value: finalValue,
          message: `Value must be at least ${schema.min}`,
          code: 'range',
        };
        finalValue = schema.min;
      }
      if (schema.max !== undefined && finalValue > schema.max) {
        error = {
          path,
          value: finalValue,
          message: `Value must be at most ${schema.max}`,
          code: 'range',
        };
        finalValue = schema.max;
      }
    }

    // Enum validation
    if (schema.enum && !schema.enum.includes(finalValue)) {
      error = {
        path,
        value: finalValue,
        message: `Value must be one of: ${schema.enum.join(', ')}`,
        code: 'enum',
      };
      return { value: schema.default, error };
    }

    // Pattern validation
    if (schema.pattern && typeof finalValue === 'string') {
      if (!schema.pattern.test(finalValue)) {
        error = {
          path,
          value: finalValue,
          message: `Value does not match required pattern`,
          code: 'pattern',
        };
      }
    }

    // Custom type validations
    if (schema.type === 'email' && typeof finalValue === 'string') {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(finalValue)) {
        error = {
          path,
          value: finalValue,
          message: `Invalid email format`,
          code: 'pattern',
        };
      }
    }

    if (schema.type === 'url' && typeof finalValue === 'string') {
      try {
        globalThis.URL(finalValue);
      } catch {
        error = {
          path,
          value: finalValue,
          message: `Invalid URL format`,
          code: 'pattern',
        };
      }
    }

    if (schema.type === 'port' && typeof finalValue === 'number') {
      if (finalValue < 1 || finalValue > 65535) {
        error = {
          path,
          value: finalValue,
          message: `Port must be between 1 and 65535`,
          code: 'range',
        };
      }
    }

    if (schema.type === 'timezone' && typeof finalValue === 'string') {
      try {
        // Basic timezone validation
        Intl.DateTimeFormat(undefined, { timeZone: finalValue });
      } catch {
        error = {
          path,
          value: finalValue,
          message: `Invalid timezone format`,
          code: 'pattern',
        };
      }
    }

    // Security checks
    if (schema.sensitive && finalValue && typeof finalValue === 'string') {
      if (finalValue.length < 8) {
        warning = {
          path,
          value: '[REDACTED]',
          message: `Sensitive value should be at least 8 characters`,
          code: 'insecure',
        };
      }
    }

    return { value: finalValue, ...(error !== undefined && { error }), ...(warning !== undefined && { warning }) };
  }

  /**
   * Check if value matches expected type
   */
  private static isValidType(value: any, type: ConfigValue['type']): boolean {
    switch (type) {
      case 'string':
      case 'email':
      case 'url':
      case 'timezone':
        return typeof value === 'string';
      case 'number':
      case 'port':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'array':
        return Array.isArray(value);
      default:
        return false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Configuration Manager                                                  */
/* ------------------------------------------------------------------ */

export class ConfigManager {
  private config: Record<string, any> = {};
  private schema: ConfigSchema;
  private options: Required<ConfigManagerOptions>;
  private listeners: Set<ConfigChangeListener> = new Set();
  private isWatching = false;
  private configPath: string;
  private lastModified?: number;

  constructor(
    schema: ConfigSchema = DEFAULT_APP_CONFIG_SCHEMA,
    options: ConfigManagerOptions = {}
  ) {
    this.schema = schema;
    this.options = {
      configFile: options.configFile || 'config.json',
      enableHotReload: options.enableHotReload ?? true,
      validateOnLoad: options.validateOnLoad ?? true,
      enableEnvOverride: options.enableEnvOverride ?? true,
      encryptionKey: options.encryptionKey || '',
      backupConfig: options.backupConfig ?? true,
    };

    this.configPath = path.resolve(process.cwd(), this.options.configFile);
  }

  /**
   * Load configuration from file and environment
   */
  async load(): Promise<ConfigValidationResult> {
    const requestId = generateRequestId();
    
    return await runWithContextAsync(
      { requestId, type: 'config' as any, name: 'config_load' },
      async () => {
        logger.info({
          event: 'config_loading',
          configFile: this.configPath,
          enableHotReload: this.options.enableHotReload,
          enableEnvOverride: this.options.enableEnvOverride,
        });

        let fileConfig: Record<string, any> = {};

        // Load from file
        try {
          const configContent = fs.readFileSync(this.configPath, 'utf-8');
          fileConfig = JSON.parse(configContent);
          
          const stats = fs.statSync(this.configPath);
          this.lastModified = stats.mtime.getTime();
          
          logger.debug({
            event: 'config_file_loaded',
            keys: Object.keys(fileConfig).length,
            lastModified: this.lastModified,
          });
        } catch (error: any) {
          if (error.code !== 'ENOENT') {
            logger.warn({ event: 'config_file_load_failed' });
          }
        }

        // Apply environment overrides
        if (this.options.enableEnvOverride) {
          const envConfig = this.loadFromEnvironment();
          fileConfig = { ...fileConfig, ...envConfig };
          
          logger.debug({
            event: 'config_env_overrides_applied',
            overrides: Object.keys(envConfig).length,
          });
        }

        // Validate configuration
        const result = ConfigValidator.validate(fileConfig, this.schema);

        if (this.options.validateOnLoad && !result.valid) {
          logger.error({
            event: 'config_validation_failed',
            errors: result.errors.map(e => ({ path: e.path, message: e.message })),
          });

          throw new Error(`Configuration validation failed: ${result.errors.map(e => e.message).join(', ')}`);
        }

        if (result.warnings.length > 0) {
          logger.warn({
            event: 'config_warnings',
            warnings: result.warnings.map(w => ({ path: w.path, message: w.message })),
          });
        }

        // Backup old config if enabled
        if (this.options.backupConfig && Object.keys(this.config).length > 0) {
          await this.backupConfiguration();
        }

        const oldConfig = { ...this.config };
        this.config = result.config;

        // Detect changes
        const changes = this.detectChanges(oldConfig, this.config);
        
        if (changes.length > 0) {
          logger.info({
            event: 'config_changes_detected',
            changes: changes.map(c => ({ path: c.path, type: c.type })),
          });
        }

        // Start file watching if enabled
        if (this.options.enableHotReload && !this.isWatching) {
          this.startWatching();
        }

        // Notify listeners
        await this.notifyListeners(this.config, changes);

        logger.info({
          event: 'config_loaded_successfully',
          valid: result.valid,
          errors: result.errors.length,
          warnings: result.warnings.length,
          configKeys: Object.keys(this.config).length,
        });

        return result;
      }
    );
  }

  /**
   * Get configuration value
   */
  get<T = any>(path: string, defaultValue?: T): T {
    const keys = path.split('.');
    let current: any = this.config;

    for (const key of keys) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return defaultValue!;
      }
      current = current[key];
    }

    return current !== undefined ? current : defaultValue!;
  }

  /**
   * Set configuration value
   */
  async set(path: string, value: any): Promise<void> {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    let current: any = this.config;

    // Create nested structure if needed
    for (const key of keys) {
      if (current[key] === undefined || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }

    const oldValue = current[lastKey];
    current[lastKey] = value;

    // Validate change
    const schemaPath = keys.length > 0 ? `${keys.join('.')}.${lastKey}` : lastKey;
    const schemaValue = this.schema[schemaPath];
    
    if (schemaValue) {
      const validation = ConfigValidator.validateValue(value, schemaValue, path);
      if (validation.error) {
        // Revert change if validation fails
        current[lastKey] = oldValue;
        throw new Error(`Invalid configuration value for ${path}: ${validation.error.message}`);
      }
    }

    // Notify listeners
    const changes: ConfigChange[] = [
      {
        path,
        oldValue,
        newValue: value,
        type: oldValue === undefined ? 'added' : 'modified',
      },
    ];

    await this.notifyListeners(this.config, changes);

    logger.debug({
      event: 'config_value_updated',
      path,
      type: changes[0]?.type,
    });
  }

  /**
   * Add configuration change listener
   */
  addListener(listener: ConfigChangeListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove configuration change listener
   */
  removeListener(listener: ConfigChangeListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Get current configuration snapshot
   */
  getConfig(): Record<string, any> {
    return JSON.parse(JSON.stringify(this.config));
  }

  /**
   * Get configuration schema
   */
  getSchema(): ConfigSchema {
    return { ...this.schema };
  }

  /**
   * Validate current configuration
   */
  validate(): ConfigValidationResult {
    return ConfigValidator.validate(this.config, this.schema);
  }

  /**
   * Load configuration values from environment variables
   */
  private loadFromEnvironment(): Record<string, any> {
    const envConfig: Record<string, any> = {};

    for (const [path, schema] of Object.entries(this.schema)) {
      if (schema.envVar && process.env[schema.envVar]) {
        const envValue = process.env[schema.envVar]!;
        
        // Type conversion
        let convertedValue: any = envValue;
        
        if (schema.type === 'boolean') {
          convertedValue = envValue.toLowerCase() === 'true';
        } else if (schema.type === 'number' || schema.type === 'port') {
          convertedValue = parseFloat(envValue);
        } else if (schema.type === 'object') {
          try {
            convertedValue = JSON.parse(envValue);
          } catch {
            logger.warn({ event: 'config_env_json_parse_failed', envVar: schema.envVar });
            continue;
          }
        }

        envConfig[path] = convertedValue;
      }
    }

    return envConfig;
  }

  /**
   * Detect changes between configurations
   */
  private detectChanges(oldConfig: Record<string, any>, newConfig: Record<string, any>): ConfigChange[] {
    const changes: ConfigChange[] = [];
    const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);

    for (const key of allKeys) {
      const oldValue = oldConfig[key];
      const newValue = newConfig[key];

      if (oldValue === undefined && newValue !== undefined) {
        changes.push({ path: key, oldValue, newValue, type: 'added' });
      } else if (oldValue !== undefined && newValue === undefined) {
        changes.push({ path: key, oldValue, newValue, type: 'deleted' });
      } else if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({ path: key, oldValue, newValue, type: 'modified' });
      }
    }

    return changes;
  }

  /**
   * Notify all listeners of configuration changes
   */
  private async notifyListeners(config: Record<string, any>, changes: ConfigChange[]): Promise<void> {
    if (changes.length === 0) return;

    const promises = Array.from(this.listeners).map(async (listener) => {
      try {
        await listener(config, changes);
      } catch (error) {
        logger.error({ event: 'config_listener_error' }, error as any);
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Start watching configuration file for changes
   */
  private startWatching(): void {
    if (this.isWatching) return;

    this.isWatching = true;
    
    fs.watchFile(this.configPath, { interval: 1000 }, async (curr: any, _prev: any) => {
      if (curr.mtime.getTime() !== this.lastModified) {
        logger.info({ event: 'config_file_modified', file: this.configPath });

        try {
          await this.load();
        } catch (error) {
          logger.error({ event: 'config_reload_failed' }, error);
        }
      }
    });

    logger.debug({
      event: 'config_watching_enabled',
      configFile: this.configPath,
    });
  }

  /**
   * Stop watching configuration file
   */
  stopWatching(): void {
    if (!this.isWatching) return;

    fs.unwatchFile(this.configPath);
    this.isWatching = false;

    logger.debug({ event: 'config_watching_disabled' });
  }

  /**
   * Backup current configuration
   */
  private async backupConfiguration(): Promise<void> {
    const backupPath = `${this.configPath}.backup.${Date.now()}`;

    try {
      const { writeFile } = fs.promises;
      await writeFile(backupPath, JSON.stringify(this.config, null, 2));

      logger.debug({ event: 'config_backed_up', backupPath });
        } catch (error) {
          logger.warn({ event: 'config_backup_failed' });
        }
  }

  /**
   * Destroy configuration manager
   */
  destroy(): void {
    this.stopWatching();
    this.listeners.clear();

    logger.info({ event: 'config_manager_destroyed' });
  }
}

/* ------------------------------------------------------------------ */
/* Global Configuration Instance                                           */
/* ------------------------------------------------------------------ */

export const configManager = new ConfigManager();

/* ------------------------------------------------------------------ */
/* Exports                                                               */
/* ------------------------------------------------------------------ */
