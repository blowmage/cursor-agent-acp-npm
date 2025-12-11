# Cursor Agent ACP Adapter

A full-featured Agent Client Protocol (ACP) adapter for Cursor CLI, enabling seamless AI-powered coding assistance in ACP-compliant editors like Zed.

## Overview

This TypeScript implementation provides a production-ready bridge between the Cursor CLI and editors that support the Agent Client Protocol. Built on the standard **stdio transport** per ACP specification, it offers feature parity with Zed's built-in Claude and Codex adapters while maintaining high performance and reliability.

## Features

- **ACP Protocol Core** - Initialize, session management, prompt processing
- **Strict Schema Compliance** - 100% adherence to [ACP Schema](https://agentclientprotocol.com/protocol/schema)
- **Stdio Transport** - Standard ACP stdio transport per protocol specification
- **Session Management** - Persistent sessions with metadata and history
- **Content Processing** - Text, code, and image block handling per ContentBlock schema
- **Real-time Streaming** - Live response streaming for immediate feedback
- **Complete Tool System** - Filesystem, terminal, and Cursor-specific tools
- **Security Framework** - Path validation, command filtering, access controls
- **Error Handling & Recovery** - Robust error handling with comprehensive validation
- **Type Safety** - Written in TypeScript with strict type checking using `@agentclientprotocol/sdk`
- **SDK Integration** - All protocol types imported from official `@agentclientprotocol/sdk`
- **Test Coverage** - 200+ unit and integration tests with security coverage
- **Cursor CLI Integration** - Complete integration with cursor-agent CLI features
- **Advanced Tool Registry** - Dynamic provider management and validation
- **Cross-Tool Workflows** - Seamless filesystem, terminal, and code operations
- **High Performance** - <100ms average response time optimization
- **Memory Efficiency** - Zero memory leaks, optimal resource usage
- **Cross-platform** - Works on macOS, Linux, and Windows

## ACP Schema Compliance

This adapter strictly adheres to the [Agent Client Protocol Schema](https://agentclientprotocol.com/protocol/schema). Key compliance features:

### Protocol Types
- **All types imported from `@agentclientprotocol/sdk`** - No custom protocol type definitions
- **PromptRequest** - Uses `prompt` field per schema (ContentBlock[])
- **SessionUpdate** - Full union type support (user_message_chunk, agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan, available_commands_update, current_mode_update)
- **ContentBlock** - Complete support for text, image, audio, resource, resource_link
- **SessionCapabilities** - Properly declared in AgentCapabilities
- **Terminal types** - Full Terminal, TerminalHandle, TerminalExitStatus support

### Validation
- **Content block validation** - Strict validation against ContentBlock schema
- **Annotations support** - Full Annotations type support with _meta extensions
- **Error responses** - JSON-RPC 2.0 compliant error structures
- **Type guards** - Runtime validation using SDK type structures

### Documentation
- **TSDoc comments** - All protocol methods link to ACP schema documentation
- **Schema references** - Direct links to relevant schema sections
- **Internal vs Protocol types** - Clear separation and documentation

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
# Start the ACP adapter with stdio transport
cursor-agent-acp

# Or run directly with npx
npx cursor-agent-acp
```

The adapter uses **stdio transport** by default, which is the standard transport for the Agent Client Protocol. The adapter reads JSON-RPC messages from stdin and writes responses to stdout, with messages delimited by newlines as specified in the [ACP Transport Specification](https://agentclientprotocol.com/protocol/transports).

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

### JetBrains IDE Integration

The adapter supports JetBrains IDEs (WebStorm, IntelliJ IDEA, PyCharm, etc.) version 25.3 and later.

Create or edit `~/.jetbrains/acp.json`:

```json
{
  "agent_servers": {
    "Cursor Agent": {
      "command": "cursor-agent-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Or configure through the IDE:
1. Open **AI Chat** tool window
2. Click ⚙️ settings → **"Configure ACP Agents"**
3. Add the configuration above

### Using with Other Editors

The adapter works with any ACP-compliant editor using the standard stdio transport. Configure your editor to launch `cursor-agent-acp` as an agent server process.

## Transport Layer

This adapter implements the **stdio transport** as specified in the [ACP Transport Specification](https://agentclientprotocol.com/protocol/transports).

### Stdio Transport (Default)

The stdio transport is the recommended transport for ACP:

- **Standard Communication**: JSON-RPC messages over stdin/stdout
- **Message Format**: Newline-delimited JSON (`\n` delimiter)
- **Logging**: Uses stderr for diagnostic output
- **No Embedded Newlines**: Messages must not contain `\n` or `\r`
- **SDK Compliant**: Uses `@agentclientprotocol/sdk` for all protocol handling

### Why Stdio?

Stdio is the default and recommended transport for ACP because:

1. **Universal Support**: Works with any process-based editor integration
2. **Simple & Reliable**: Well-understood subprocess communication
3. **Specification Compliant**: Follows ACP transport specification exactly
4. **SDK Integration**: Full support via `@agentclientprotocol/sdk`

For more details, see [`docs/TRANSPORTS.md`](docs/TRANSPORTS.md).

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
│  │  • Initialization  • Session Management         ││
│  │  • Prompt Handling • Content Processing         ││
│  │  • Tool Calling    • Error Handling             ││
│  └─────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────┐│
│  │           Integration Layer                     ││
│  │  • CLI Bridge     • Authentication              ││
│  │  • Session Sync   • Response Translation        ││
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
