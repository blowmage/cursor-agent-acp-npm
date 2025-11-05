"use strict";
// Global test setup for unit tests
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEST_CONSTANTS = exports.testHelpers = void 0;
var globals_1 = require("@jest/globals");
// Increase max listeners to prevent warnings during parallel test execution
// Jest adds listeners for each test suite for exit handling
// Set to 30 to accommodate 6 test suites running in parallel
process.setMaxListeners(30);
// Extend Jest timeout for all tests
globals_1.jest.setTimeout(10000);
// Mock console methods to reduce noise during tests unless explicitly needed
var originalConsole = global.console;
global.console = __assign(__assign({}, originalConsole), { log: globals_1.jest.fn(), info: globals_1.jest.fn(), warn: globals_1.jest.fn(), error: globals_1.jest.fn(), debug: globals_1.jest.fn() });
// Mock process.exit to prevent tests from actually exiting
var mockExit = globals_1.jest.fn();
Object.defineProperty(process, 'exit', {
    value: mockExit,
    writable: true,
});
// Mock environment variables for consistent testing
process.env.NODE_ENV = 'test';
process.env.CURSOR_AGENT_ACP_LOG_LEVEL = 'error';
process.env.CURSOR_AGENT_ACP_SESSION_DIR = '/tmp/test-sessions';
// Custom Jest matchers
expect.extend({
    toBeValidSessionId: function (received) {
        var isValid = typeof received === 'string' &&
            received.length > 0 &&
            /^[a-zA-Z0-9-_]+$/.test(received);
        if (isValid) {
            return {
                message: function () { return "expected ".concat(received, " not to be a valid session ID"); },
                pass: true,
            };
        }
        return {
            message: function () { return "expected ".concat(received, " to be a valid session ID"); },
            pass: false,
        };
    },
    toBeValidAcpResponse: function (received) {
        // For initialization responses and other direct results (not JSON-RPC wrapped)
        var isDirectResult = received &&
            typeof received === 'object' &&
            (received.protocolVersion !== undefined ||
                received.capabilities !== undefined ||
                received.sessionId !== undefined);
        // For JSON-RPC wrapped responses
        var isJsonRpcResponse = received &&
            typeof received === 'object' &&
            typeof received.jsonrpc === 'string' &&
            received.jsonrpc === '2.0' &&
            (received.result !== undefined || received.error !== undefined) &&
            (typeof received.id === 'string' ||
                typeof received.id === 'number' ||
                received.id === null);
        var isValid = isDirectResult || isJsonRpcResponse;
        if (isValid) {
            return {
                message: function () { return "expected response not to be valid ACP response"; },
                pass: true,
            };
        }
        return {
            message: function () {
                return "expected response to be valid ACP response, got: ".concat(JSON.stringify(received));
            },
            pass: false,
        };
    },
    toBeValidInitializeResult: function (received) {
        var isValid = received &&
            typeof received === 'object' &&
            typeof received.protocolVersion === 'string' &&
            received.serverInfo &&
            typeof received.serverInfo.name === 'string' &&
            typeof received.serverInfo.version === 'string' &&
            received.capabilities &&
            typeof received.capabilities === 'object';
        if (isValid) {
            return {
                message: function () { return "expected response not to be valid initialize result"; },
                pass: true,
            };
        }
        return {
            message: function () {
                return "expected response to be valid initialize result, got: ".concat(JSON.stringify(received));
            },
            pass: false,
        };
    },
});
// Clean up after each test
afterEach(function () {
    // Clear all mocks
    globals_1.jest.clearAllMocks();
    // Clear console mocks
    global.console.log.mockClear();
    global.console.info.mockClear();
    global.console.warn.mockClear();
    global.console.error.mockClear();
    global.console.debug.mockClear();
    // Reset process.exit mock
    mockExit.mockClear();
});
// Global cleanup
afterAll(function () {
    // Restore original console
    global.console = originalConsole;
});
// Helper functions for tests
exports.testHelpers = {
    // Create a mock ACP request
    createMockAcpRequest: function (method, params, id) {
        if (params === void 0) { params = {}; }
        if (id === void 0) { id = 1; }
        return ({
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: id,
        });
    },
    // Create a mock ACP response
    createMockAcpResponse: function (result, id) {
        if (id === void 0) { id = 1; }
        return ({
            jsonrpc: '2.0',
            result: result,
            id: id,
        });
    },
    // Create a mock ACP error response
    createMockAcpError: function (code, message, id) {
        if (id === void 0) { id = 1; }
        return ({
            jsonrpc: '2.0',
            error: { code: code, message: message },
            id: id,
        });
    },
    // Generate a test session ID
    generateTestSessionId: function () {
        return "test-session-".concat(Date.now(), "-").concat(Math.random().toString(36).substr(2, 9));
    },
    // Wait for a specified amount of time
    wait: function (ms) {
        return new Promise(function (resolve) { return setTimeout(resolve, ms); });
    },
    // Create a temporary directory for testing
    createTempDir: function () { return __awaiter(void 0, void 0, void 0, function () {
        var fs, path, os, tempDir;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return __importStar(require('fs/promises')); })];
                case 1:
                    fs = _a.sent();
                    return [4 /*yield*/, Promise.resolve().then(function () { return __importStar(require('path')); })];
                case 2:
                    path = _a.sent();
                    return [4 /*yield*/, Promise.resolve().then(function () { return __importStar(require('os')); })];
                case 3:
                    os = _a.sent();
                    tempDir = path.join(os.tmpdir(), "cursor-acp-test-".concat(Date.now()));
                    return [4 /*yield*/, fs.mkdir(tempDir, { recursive: true })];
                case 4:
                    _a.sent();
                    return [2 /*return*/, tempDir];
            }
        });
    }); },
    // Clean up temporary directory
    cleanupTempDir: function (dirPath) { return __awaiter(void 0, void 0, void 0, function () {
        var fs, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return __importStar(require('fs/promises')); })];
                case 1:
                    fs = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, fs.rm(dirPath, { recursive: true, force: true })];
                case 3:
                    _a.sent();
                    return [3 /*break*/, 5];
                case 4:
                    error_1 = _a.sent();
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    }); },
};
// Export commonly used test constants
exports.TEST_CONSTANTS = {
    DEFAULT_TIMEOUT: 5000,
    LONG_TIMEOUT: 10000,
    SHORT_TIMEOUT: 1000,
    MOCK_SESSION_ID: 'mock-session-12345',
    MOCK_USER_ID: 'test-user',
    SAMPLE_TEXT_CONTENT: 'This is sample text content for testing',
    SAMPLE_CODE_CONTENT: 'console.log("Hello, world!");',
    ACP_PROTOCOL_VERSION: 1, // Per ACP spec: protocol versions are integers
};
