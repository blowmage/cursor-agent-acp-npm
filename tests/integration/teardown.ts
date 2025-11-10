/**
 * Integration test teardown
 *
 * This file handles cleanup of any global resources after all tests complete.
 * It ensures clean shutdown of processes, timers, and connections.
 */

export default async (): Promise<void> => {
  // Give adequate time for all child processes to terminate
  // Reduced delay since forceExit will handle remaining handles
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Clear any lingering timers
  if (global.gc) {
    global.gc();
  }
};
