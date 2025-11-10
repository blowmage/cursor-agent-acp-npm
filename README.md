# Cursor Agent ACP Adapter

A full-featured Agent Client Protocol (ACP) adapter for Cursor CLI, enabling seamless AI-powered coding assistance in ACP-compliant editors like Zed.

## Overview

This TypeScript implementation provides a production-ready bridge between the Cursor CLI and editors that support the Agent Client Protocol. It offers feature parity with Zed's built-in Claude and Codex adapters while maintaining high performance and reliability.

## Features

- **ACP Protocol Core** - Initialize, session management, prompt processing
- **Session Management** - Persistent sessions with metadata and history
- **Content Processing** - Text, code, and image block handling
- **Real-time Streaming** - Live response streaming for immediate feedback
- **Complete Tool System** - Filesystem, terminal, and Cursor-specific tools
- **Security Framework** - Path validation, command filtering, access controls
- **Error Handling & Recovery** - Robust error handling with comprehensive validation
- **Type Safety** - Written in TypeScript with strict type checking
- **Test Coverage** - 200+ unit and integration tests with security coverage
- **Cursor CLI Integration** - Complete integration with cursor-agent CLI features
- **Advanced Tool Registry** - Dynamic provider management and validation
- **Cross-Tool Workflows** - Seamless filesystem, terminal, and code operations
- **High Performance** - <100ms average response time optimization
- **Memory Efficiency** - Zero memory leaks, optimal resource usage
- **Cross-platform** - Works on macOS, Linux, and Windows

## Installation

### Prerequisites

1. **Node.js 18+** - Required for running the adapter
2. **Cursor CLI** - Must be installed and authenticated

```bash
# Install Cursor CLI
curl https://cursor.com/install -fsSL | bash

# Authenticate with your Cursor account
cursor-agent login
```

### Install the Adapter

```bash
# Install globally
npm install -g @blowmage/cursor-agent-acp

# Or install locally in your project
npm install @blowmage/cursor-agent-acp
```

## Usage

### Basic Usage

```bash
# Start the ACP adapter
cursor-agent-acp

# Or run directly with npx
npx cursor-agent-acp
```

### Zed Editor Integration

Add this configuration to your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "agent_servers": {
    "cursor-agent": {
      "command": "cursor-agent-acp",
      "args": [],
      "env": {}
    }
  }
}
```

If installed locally:

```json
{
  "agent_servers": {
    "cursor-agent": {
      "command": "npx",
      "args": ["@blowmage/cursor-agent-acp"],
      "env": {}
    }
  }
}
```

### Using with Other Editors

The adapter works with any ACP-compliant editor. Configure your editor to launch `cursor-agent-acp` as an agent server using stdio transport.

## Configuration

The adapter supports various configuration options:

```bash
# Custom configuration file
cursor-agent-acp --config /path/to/config.json

# Set log level
cursor-agent-acp --log-level debug

# Specify session storage directory
cursor-agent-acp --session-dir ~/.cursor-sessions
```

### Configuration File Example

```json
{
  "logLevel": "info",
  "sessionDir": "~/.cursor-sessions",
  "maxSessions": 100,
  "sessionTimeout": 3600000,
  "tools": {
    "filesystem": {
      "enabled": true,
      "allowedPaths": ["./"],
      "maxFileSize": 10485760,
      "allowedExtensions": [".ts", ".js", ".json", ".md"]
    },
    "terminal": {
      "enabled": true,
      "maxProcesses": 5,
      "defaultOutputByteLimit": 10485760,
      "maxOutputByteLimit": 52428800,
      "forbiddenCommands": ["rm", "sudo", "su"],
      "allowedCommands": [],
      "defaultCwd": "./"
    },
    "cursor": {
      "enabled": true,
      "enableCodeModification": true,
      "enableTestExecution": true,
      "maxSearchResults": 50
    }
  },
  "cursor": {
    "timeout": 30000,
    "retries": 3
  }
}
```

## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/blowmage/cursor-agent-acp.git
cd cursor-agent-acp

# Install dependencies
npm install

# Build the project
npm run build
```

### Testing

```bash
# Run unit tests
npm test

# Run integration tests
npm run test:integration

# Run all tests with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch
```

### Development Server

```bash
# Run in development mode with hot reload
npm run dev

# Build and watch for changes
npm run build:watch
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 ACP Editor (Zed)                    │
└─────────────────┬───────────────────────────────────┘
                  │ JSON-RPC over stdio
┌─────────────────▼───────────────────────────────────┐
│             Cursor Agent ACP Adapter                │
│  ┌─────────────────────────────────────────────────┐│
│  │           Protocol Layer                        ││
│  │  • Initialization  • Session Management        ││
│  │  • Prompt Handling • Content Processing        ││
│  │  • Tool Calling    • Error Handling            ││
│  └─────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────┐│
│  │           Integration Layer                     ││
│  │  • CLI Bridge     • Authentication             ││
│  │  • Session Sync   • Response Translation       ││
│  └─────────────────────────────────────────────────┘│
└─────────────────┬───────────────────────────────────┘
                  │ Command execution
┌─────────────────▼───────────────────────────────────┐
│                Cursor CLI                           │
└─────────────────────────────────────────────────────┘
```

## API Documentation

### Core Classes

- **`CursorAgentAdapter`** - Main adapter class implementing ACP protocol
- **`SessionManager`** - Handles session lifecycle and persistence
- **`CursorCliBridge`** - Interfaces with cursor-agent CLI
- **`ToolRegistry`** - Manages available tools and capabilities

### Supported ACP Methods

- `initialize` - Initialize the adapter with capabilities
- `session/new` - Create a new conversation session
- `session/load` - Load an existing session
- `session/list` - List all available sessions
- `session/update` - Update session metadata
- `session/delete` - Delete a session
- `session/prompt` - Send a prompt and receive streaming response

### Available Tools

- **File System Tools**
  - `read_file` - Read file contents with security validation
  - `write_file` - Write file contents with path restrictions
  - `list_directory` - List directory contents recursively
  - `create_directory` - Create directories with parent support
  - `delete_file` - Delete files/directories with safety checks
  - `get_file_info` - Get detailed file/directory information

- **Terminal Tools**
  - `execute_command` - Execute shell commands with security filtering
  - `start_shell_session` - Start interactive shell sessions
  - `send_to_shell` - Send input to active shell sessions
  - `close_shell_session` - Close and cleanup shell sessions
  - `list_processes` - List active processes and sessions

- **Cursor-Specific Tools**
  - `search_codebase` - Advanced code search with pattern matching
  - `analyze_code` - Code structure and quality analysis
  - `apply_code_changes` - Atomic code modifications with backup
  - `run_tests` - Execute tests with framework auto-detection
  - `get_project_info` - Project metadata and dependency information
  - `explain_code` - AI-powered code explanations and suggestions

## Troubleshooting

### Common Issues

**"cursor-agent not found"**
```bash
# Install Cursor CLI
curl https://cursor.com/install -fsSL | bash

# Verify installation
cursor-agent --version
```

**"Authentication required"**
```bash
# Login to Cursor
cursor-agent login

# Check authentication status
cursor-agent status
```

**"Permission denied"**
```bash
# Make sure the binary is executable
chmod +x ./node_modules/.bin/cursor-agent-acp
```

**"Session not found"**
- Sessions are stored locally and may expire
- Check session directory permissions
- Verify session storage configuration

### Debug Mode

Enable debug logging to troubleshoot issues:

```bash
cursor-agent-acp --log-level debug
```

Check logs in:
- **macOS/Linux**: `~/.cursor-agent-acp/logs/`
- **Windows**: `%APPDATA%\cursor-agent-acp\logs\`

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

### Development Workflow

1. Fork the repository
2. Create a feature branch
3. Write tests for your changes
4. Implement the feature
5. Ensure all tests pass
6. Submit a pull request

### Code Standards

- **TypeScript**: Strict mode enabled
- **Testing**: >95% test coverage required
- **Linting**: ESLint + Prettier
- **Commits**: Conventional commit messages

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/blowmage/cursor-agent-acp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/blowmage/cursor-agent-acp/discussions)
- **Documentation**: [Full API Docs](https://blowmage.github.io/cursor-agent-acp)

## Related Projects

- [Agent Client Protocol](https://agentclientprotocol.com) - Official ACP specification
- [Cursor CLI](https://cursor.com/docs/cli) - Official Cursor command-line interface
- [Zed Editor](https://zed.dev) - High-performance code editor with ACP support
