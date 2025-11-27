/**
 * Tests for cursor-agent-acp CLI binary
 *
 * Tests command-line argument parsing, version display, and other CLI functionality
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { readFileSync } from 'fs';

describe('cursor-agent-acp CLI', () => {
  const binPath = join(__dirname, '../../../dist/bin/cursor-agent-acp.js');
  let childProcess: ChildProcess | null = null;

  // Get expected version from package.json
  const packagePath = join(__dirname, '../../../package.json');
  const packageInfo = JSON.parse(readFileSync(packagePath, 'utf8'));
  const EXPECTED_VERSION = packageInfo.version;

  afterEach(() => {
    // Clean up any running child processes
    if (childProcess && !childProcess.killed) {
      childProcess.kill('SIGTERM');
      childProcess = null;
    }
  });

  describe('version flags', () => {
    it('should display version with -v flag', async () => {
      const output = await runCli(['-v']);

      expect(output.stdout).toContain(EXPECTED_VERSION);
      expect(output.exitCode).toBe(0);
      expect(output.stderr).toBe('');
    });

    it('should display version with --version flag', async () => {
      const output = await runCli(['--version']);

      expect(output.stdout).toContain(EXPECTED_VERSION);
      expect(output.exitCode).toBe(0);
      expect(output.stderr).toBe('');
    });

    it('should display same version for both -v and --version', async () => {
      const output1 = await runCli(['-v']);
      const output2 = await runCli(['--version']);

      expect(output1.stdout).toBe(output2.stdout);
      expect(output1.exitCode).toBe(output2.exitCode);
    });

    it('should not display anything else with version flag', async () => {
      const output = await runCli(['--version']);

      // Should only contain version number, no other output
      const lines = output.stdout.trim().split('\n');
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/^\d+\.\d+\.\d+/); // Semantic version format
    });

    it('should exit immediately after showing version', async () => {
      const startTime = Date.now();
      await runCli(['--version']);
      const duration = Date.now() - startTime;

      // Should complete very quickly (under 1 second)
      expect(duration).toBeLessThan(1000);
    });

    it('should prioritize version flag over other options', async () => {
      // Version should be shown even if other options are provided
      const output = await runCli(['--version', '--validate', '--test-cursor']);

      expect(output.stdout).toContain(EXPECTED_VERSION);
      expect(output.exitCode).toBe(0);
      // Should not run validate or test-cursor
      expect(output.stdout).not.toContain('valid');
      expect(output.stdout).not.toContain('cursor');
    });

    it('should handle version flag with config file option', async () => {
      const output = await runCli([
        '--version',
        '--config',
        '/nonexistent/config.json',
      ]);

      // Version should be shown without trying to load config
      expect(output.stdout).toContain(EXPECTED_VERSION);
      expect(output.exitCode).toBe(0);
      expect(output.stderr).not.toContain('Failed to load');
    });
  });

  describe('help output', () => {
    it('should show help with --help flag', async () => {
      const output = await runCli(['--help']);

      expect(output.stdout).toContain('Usage:');
      expect(output.stdout).toContain('cursor-agent-acp');
      expect(output.stdout).toContain('Options:');
      expect(output.exitCode).toBe(0);
    });

    it('should show help with -h flag', async () => {
      const output = await runCli(['-h']);

      expect(output.stdout).toContain('Usage:');
      expect(output.stdout).toContain('cursor-agent-acp');
      expect(output.exitCode).toBe(0);
    });

    it('should show version option in help', async () => {
      const output = await runCli(['--help']);

      expect(output.stdout).toContain('-v, --version');
      expect(output.stdout).toContain('output the version number');
    });
  });

  describe('command parsing', () => {
    it('should recognize auth command', async () => {
      const output = await runCli(['auth', '--help']);

      expect(output.stdout).toContain('auth');
      expect(output.exitCode).toBe(0);
    });

    it('should show auth subcommands in help', async () => {
      const output = await runCli(['auth', '--help']);

      expect(output.stdout).toContain('login');
      expect(output.exitCode).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should show error for invalid command', async () => {
      const output = await runCli(['invalid-command']);

      expect(output.stderr).toContain('error');
      expect(output.exitCode).not.toBe(0);
    });

    it('should show error for invalid option', async () => {
      const output = await runCli(['--invalid-option']);

      expect(output.stderr).toContain('error');
      expect(output.exitCode).not.toBe(0);
    });
  });

  // Helper function to run CLI and capture output
  async function runCli(args: string[]): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timeoutHandle: NodeJS.Timeout | null = null;

      childProcess = spawn('node', [binPath, ...args], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          CURSOR_AGENT_ACP_LOG_LEVEL: 'error',
        },
      });

      childProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      childProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        });
      });

      childProcess.on('error', (error) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        reject(error);
      });

      // Set a timeout to prevent hanging tests
      timeoutHandle = setTimeout(() => {
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGTERM');
          reject(new Error('Test timeout: CLI process did not exit'));
        }
      }, 5000);
    });
  }
});
