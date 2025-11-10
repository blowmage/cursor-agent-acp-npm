#!/usr/bin/env node

/**
 * Cursor Agent ACP Adapter CLI Entry Point
 *
 * This is the main executable that starts the ACP adapter server.
 * It handles command-line arguments, configuration, and starts the adapter.
 */

import { program } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { CursorAgentAdapter } from '../adapter/cursor-agent-adapter';
import { CursorCliBridge } from '../cursor/cli-bridge';
import { createLogger } from '../utils/logger';
import { validateConfig } from '../utils/config';
import { DEFAULT_CONFIG } from '../index';
import type { AdapterConfig } from '../types';

interface CliOptions {
  config?: string;
  logLevel: string;
  logFile?: string;
  sessionDir: string;
  port?: string;
  stdio: boolean;
  http?: boolean;
  timeout: string;
  retries: string;
  maxSessions: string;
  sessionTimeout: string;
  noFilesystem?: boolean;
  noTerminal?: boolean;
  maxProcesses: string;
  verbose?: boolean;
  quiet?: boolean;
  validate?: boolean;
  testCursor?: boolean;
}

// Read version from package.json
const packagePath = join(__dirname, '../../package.json');
const packageInfo = JSON.parse(readFileSync(packagePath, 'utf8'));
const VERSION = packageInfo.version;

// Setup command line interface
program
  .name('cursor-agent-acp')
  .description('Agent Client Protocol adapter for Cursor CLI')
  .version(VERSION);

// Auth command group
const authCommand = program
  .command('auth')
  .description('Authentication commands');

authCommand
  .command('login')
  .description('Login to Cursor CLI')
  .option('--check', 'check authentication status after login', false)
  .action(async (options) => {
    await handleAuthLogin(options);
  });

// Main program options
program
  .option('-c, --config <path>', 'path to configuration file')
  .option(
    '-l, --log-level <level>',
    'logging level (error, warn, info, debug)',
    'info'
  )
  .option('--log-file <path>', 'log file path (logs to stderr by default)')
  .option(
    '-s, --session-dir <path>',
    'session storage directory',
    '~/.cursor-sessions'
  )
  .option('-p, --port <number>', 'port to listen on (for HTTP transport)')
  .option('--stdio', 'use stdio transport (default)', true)
  .option('--http', 'use HTTP transport instead of stdio')
  .option('-t, --timeout <ms>', 'cursor-agent timeout in milliseconds', '30000')
  .option(
    '-r, --retries <count>',
    'number of retries for cursor-agent commands',
    '3'
  )
  .option(
    '--max-sessions <count>',
    'maximum number of concurrent sessions',
    '100'
  )
  .option(
    '--session-timeout <ms>',
    'session timeout in milliseconds',
    '3600000'
  )
  .option('--no-filesystem', 'disable filesystem tools')
  .option('--no-terminal', 'disable terminal tools')
  .option(
    '--max-processes <count>',
    'maximum number of terminal processes',
    '5'
  )
  .option('-v, --verbose', 'enable verbose logging')
  .option('-q, --quiet', 'suppress all output except errors')
  .option('--validate', 'validate configuration and exit')
  .option('--test-cursor', 'test cursor-agent connectivity and exit')
  .action(() => {
    // Default action: run the adapter in stdio mode
    // This runs when no subcommand is specified
  });

program.parse();

// Only run main() if no subcommand was executed
// Check process.argv directly to detect if 'auth' subcommand was used
const isSubcommand = process.argv.some((arg) => ['auth', 'help'].includes(arg));

const options = program.opts() as CliOptions;

/**
 * Handle auth login command
 */
async function handleAuthLogin(options: { check?: boolean }): Promise<void> {
  const logger = createLogger({ level: 'info' });

  logger.info('Starting Cursor CLI login...');
  logger.info('This will open your browser for authentication.');

  return new Promise<void>((resolve, reject) => {
    const childProcess = spawn('cursor-agent', ['login'], {
      stdio: 'inherit', // Inherit stdin/stdout/stderr for interactive login
      env: { ...process.env },
    });

    childProcess.on('close', async (code: number | null) => {
      if (code === 0) {
        logger.info('Login completed successfully!');

        // Check authentication status if requested
        if (options.check) {
          try {
            const config: AdapterConfig = { ...DEFAULT_CONFIG };
            const bridge = new CursorCliBridge(config, logger);
            const authStatus = await bridge.checkAuthentication();

            if (authStatus.authenticated) {
              logger.info('✅ Authentication verified');
              if (authStatus.user) {
                logger.info(`   User: ${authStatus.user}`);
              }
              if (authStatus.email) {
                logger.info(`   Email: ${authStatus.email}`);
              }
              if (authStatus.plan) {
                logger.info(`   Plan: ${authStatus.plan}`);
              }
            } else {
              logger.warn('⚠️  Authentication check failed');
              if (authStatus.error) {
                logger.warn(`   Error: ${authStatus.error}`);
              }
            }

            await bridge.close();
          } catch (error) {
            logger.warn(
              `Failed to verify authentication: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        resolve();
        process.exit(0);
      } else {
        logger.error(`Login failed with exit code ${code}`);
        reject(new Error(`Login failed with exit code ${code}`));
        process.exit(code || 1);
      }
    });

    childProcess.on('error', (error: Error) => {
      logger.error(`Failed to start login process: ${error.message}`);
      reject(error);
      process.exit(1);
    });
  });
}

async function main(): Promise<void> {
  try {
    // Create logger based on options
    const logLevel = options.quiet
      ? 'error'
      : options.verbose
        ? 'debug'
        : (options.logLevel as 'error' | 'warn' | 'info' | 'debug');
    const logger = createLogger({
      level: logLevel,
      ...(options.logFile !== undefined && { filename: options.logFile }),
    });

    logger.info(`Starting Cursor Agent ACP Adapter v${VERSION}`);

    // Load and merge configuration
    let config: AdapterConfig = { ...DEFAULT_CONFIG };

    // Load config file if specified
    if (options.config) {
      try {
        const configFile = readFileSync(options.config, 'utf8');
        const fileConfig = JSON.parse(configFile) as Partial<AdapterConfig>;
        config = { ...config, ...fileConfig };
        logger.info(`Loaded configuration from ${options.config}`);
      } catch (error) {
        logger.error(
          `Failed to load configuration file: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
    }

    // Override config with command line options
    if (options.logLevel) {
      config.logLevel = options.logLevel as 'error' | 'warn' | 'info' | 'debug';
    }
    if (options.sessionDir) {
      config.sessionDir = options.sessionDir;
    }
    if (options.timeout) {
      config.cursor.timeout = parseInt(options.timeout, 10);
    }
    if (options.retries) {
      config.cursor.retries = parseInt(options.retries, 10);
    }
    if (options.maxSessions) {
      config.maxSessions = parseInt(options.maxSessions, 10);
    }
    if (options.sessionTimeout) {
      config.sessionTimeout = parseInt(options.sessionTimeout, 10);
    }
    if (options.maxProcesses) {
      config.tools.terminal.maxProcesses = parseInt(options.maxProcesses, 10);
    }
    if (options.noFilesystem) {
      config.tools.filesystem.enabled = false;
    }
    if (options.noTerminal) {
      config.tools.terminal.enabled = false;
    }

    // Validate configuration
    const validation = validateConfig(config);
    if (!validation.valid) {
      logger.error('Configuration validation failed:');
      validation.errors.forEach((error: string) =>
        logger.error(`  - ${error}`)
      );
      process.exit(1);
    }

    // If --validate flag is set, just validate and exit
    if (options.validate) {
      logger.info('Configuration is valid');
      process.exit(0);
    }

    // Create and start the adapter
    const adapter = new CursorAgentAdapter(config, { logger });

    // Initialize the adapter
    logger.info('Initializing adapter components...');
    await adapter.initialize();

    // Test cursor-agent connectivity if requested
    if (options.testCursor) {
      logger.info('Testing cursor-agent connectivity...');
      const status = adapter.getStatus();
      if (status.components['cursorBridge']) {
        logger.info('✅ cursor-agent adapter is initialized and ready');
        logger.info('Components:', status.components);
        process.exit(0);
      } else {
        logger.error('❌ cursor-agent adapter initialization failed');
        process.exit(1);
      }
    }

    // Setup graceful shutdown
    const shutdown = async (signal: string): Promise<void> => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      try {
        await adapter.shutdown();
        logger.info('Adapter stopped successfully');
        process.exit(0);
      } catch (error) {
        logger.error(
          `Error during shutdown: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection:', reason);
      process.exit(1);
    });

    // Start the adapter
    logger.info('Starting ACP adapter server...');

    if (options.http) {
      // HTTP transport mode
      const port = options.port ? parseInt(options.port, 10) : 3000;
      await adapter.startHttpServer(port);
      logger.info(`🚀 ACP adapter listening on HTTP port ${port}`);
    } else {
      // Default stdio transport mode
      await adapter.startStdio();
      logger.info('🚀 ACP adapter listening on stdio');
    }

    // Keep the process running - don't write to stdout!
    // stdout is reserved for JSON-RPC messages only in ACP protocol
  } catch (error) {
    const logger = createLogger({ level: 'error' });
    logger.error('Fatal error starting adapter:', error);
    process.exit(1);
  }
}

// Handle top-level errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the application
// Only run main() if we're not executing a subcommand (like auth login)
if (require.main === module && !isSubcommand) {
  main().catch((error) => {
    console.error('Failed to start:', error);
    process.exit(1);
  });
}
