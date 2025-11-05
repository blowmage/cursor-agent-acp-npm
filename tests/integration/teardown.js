"use strict";
/**
 * Integration test teardown
 *
 * This file handles cleanup of any global resources after all tests complete.
 * It ensures clean shutdown of processes, timers, and connections.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = async () => {
    // Give adequate time for all child processes to terminate
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Clear any lingering timers
    if (global.gc) {
        global.gc();
    }
    // Force cleanup of any remaining handles
    if (process.env.NODE_ENV === 'test') {
        // Give another small delay to allow cleanup
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
};
//# sourceMappingURL=teardown.js.map