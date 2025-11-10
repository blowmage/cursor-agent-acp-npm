/**
 * Connection Pool for High-Throughput ACP Connections
 *
 * Manages a pool of concurrent connections to handle high-throughput
 * scenarios efficiently. Provides:
 * - Connection reuse
 * - Concurrency limits
 * - Resource cleanup
 * - Metrics and monitoring
 */

import type { Logger } from '../types';

export interface ConnectionPoolConfig {
  /** Maximum number of concurrent connections */
  maxConnections: number;

  /** Maximum time a connection can be idle before cleanup (ms) */
  maxIdleTime: number;

  /** Maximum time to wait for an available connection (ms) */
  acquireTimeout: number;

  /** Enable metrics collection */
  enableMetrics: boolean;
}

export interface ConnectionPoolMetrics {
  /** Total connections created */
  totalCreated: number;

  /** Total connections destroyed */
  totalDestroyed: number;

  /** Currently active connections */
  activeConnections: number;

  /** Currently idle connections */
  idleConnections: number;

  /** Total requests served */
  totalRequests: number;

  /** Requests currently waiting for a connection */
  waitingRequests: number;

  /** Average wait time for acquiring a connection (ms) */
  averageWaitTime: number;

  /** Peak concurrent connections */
  peakConnections: number;
}

interface PooledConnection<T> {
  id: string;
  connection: T;
  createdAt: Date;
  lastUsedAt: Date;
  inUse: boolean;
  requestCount: number;
}

interface WaitingRequest<T> {
  resolve: (connection: PooledConnection<T>) => void;
  reject: (error: Error) => void;
  requestedAt: Date;
}

/**
 * Generic connection pool for managing concurrent connections
 */
export class ConnectionPool<T> {
  private config: ConnectionPoolConfig;
  private logger: Logger;
  private connections: Map<string, PooledConnection<T>> = new Map();
  private waitingQueue: WaitingRequest<T>[] = [];
  private metrics: ConnectionPoolMetrics;
  private cleanupInterval?: NodeJS.Timeout;
  private nextConnectionId = 0;

  constructor(config: Partial<ConnectionPoolConfig>, logger: Logger) {
    this.config = {
      maxConnections: config.maxConnections ?? 100,
      maxIdleTime: config.maxIdleTime ?? 60000, // 1 minute
      acquireTimeout: config.acquireTimeout ?? 5000, // 5 seconds
      enableMetrics: config.enableMetrics ?? true,
    };

    this.logger = logger;

    this.metrics = {
      totalCreated: 0,
      totalDestroyed: 0,
      activeConnections: 0,
      idleConnections: 0,
      totalRequests: 0,
      waitingRequests: 0,
      averageWaitTime: 0,
      peakConnections: 0,
    };

    // Start cleanup interval
    this.startCleanup();

    this.logger.info('Connection pool initialized', {
      maxConnections: this.config.maxConnections,
      maxIdleTime: this.config.maxIdleTime,
      acquireTimeout: this.config.acquireTimeout,
    });
  }

  /**
   * Acquire a connection from the pool
   * Creates a new connection if none are available and under the limit
   */
  async acquire(factory: () => Promise<T> | T): Promise<{
    connection: T;
    release: () => void;
  }> {
    const startTime = Date.now();
    this.metrics.totalRequests++;
    this.metrics.waitingRequests++;

    try {
      // Try to get an idle connection
      const idleConnection = this.getIdleConnection();
      if (idleConnection) {
        this.markInUse(idleConnection);
        this.updateWaitTime(Date.now() - startTime);
        this.metrics.waitingRequests--;

        return {
          connection: idleConnection.connection,
          release: () => this.release(idleConnection.id),
        };
      }

      // Create new connection if under limit
      if (this.connections.size < this.config.maxConnections) {
        const pooledConnection = await this.createConnection(factory);
        this.markInUse(pooledConnection);
        this.updateWaitTime(Date.now() - startTime);
        this.metrics.waitingRequests--;

        return {
          connection: pooledConnection.connection,
          release: () => this.release(pooledConnection.id),
        };
      }

      // Wait for a connection to become available
      this.logger.debug('Waiting for available connection', {
        activeConnections: this.metrics.activeConnections,
        waitingRequests: this.metrics.waitingRequests,
      });

      const pooledConnection = await this.waitForConnection(
        this.config.acquireTimeout
      );
      this.markInUse(pooledConnection);
      this.updateWaitTime(Date.now() - startTime);
      this.metrics.waitingRequests--;

      return {
        connection: pooledConnection.connection,
        release: () => this.release(pooledConnection.id),
      };
    } catch (error) {
      this.metrics.waitingRequests--;
      throw error;
    }
  }

  /**
   * Release a connection back to the pool
   */
  private release(connectionId: string): void {
    const pooledConnection = this.connections.get(connectionId);
    if (!pooledConnection) {
      this.logger.warn('Attempted to release unknown connection', {
        connectionId,
      });
      return;
    }

    pooledConnection.inUse = false;
    pooledConnection.lastUsedAt = new Date();
    pooledConnection.requestCount++;

    this.metrics.activeConnections--;
    this.metrics.idleConnections++;

    this.logger.debug('Connection released', {
      connectionId,
      requestCount: pooledConnection.requestCount,
      activeConnections: this.metrics.activeConnections,
      idleConnections: this.metrics.idleConnections,
    });

    // Try to serve waiting requests
    this.serveWaitingRequest();
  }

  /**
   * Get current pool metrics
   */
  getMetrics(): ConnectionPoolMetrics {
    return { ...this.metrics };
  }

  /**
   * Drain the pool - wait for all active connections to finish
   */
  async drain(): Promise<void> {
    this.logger.info('Draining connection pool', {
      activeConnections: this.metrics.activeConnections,
      idleConnections: this.metrics.idleConnections,
    });

    // Wait for active connections to finish (with timeout)
    const drainTimeout = 30000; // 30 seconds
    const startTime = Date.now();

    while (
      this.metrics.activeConnections > 0 &&
      Date.now() - startTime < drainTimeout
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.metrics.activeConnections > 0) {
      this.logger.warn('Drain timeout - forcing cleanup', {
        remainingActive: this.metrics.activeConnections,
      });
    }
  }

  /**
   * Shutdown the pool - close all connections
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down connection pool');

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      delete this.cleanupInterval;
    }

    // Drain active connections
    await this.drain();

    // Destroy all remaining connections
    const connectionIds = Array.from(this.connections.keys());
    for (const id of connectionIds) {
      await this.destroyConnection(id);
    }

    // Reject waiting requests
    for (const waiting of this.waitingQueue) {
      waiting.reject(new Error('Connection pool shutting down'));
    }
    this.waitingQueue = [];

    this.logger.info('Connection pool shutdown complete', {
      finalMetrics: this.metrics,
    });
  }

  // Private helper methods

  private getIdleConnection(): PooledConnection<T> | undefined {
    for (const conn of this.connections.values()) {
      if (!conn.inUse) {
        return conn;
      }
    }
    return undefined;
  }

  private async createConnection(
    factory: () => Promise<T> | T
  ): Promise<PooledConnection<T>> {
    const id = `conn-${++this.nextConnectionId}`;
    const connection = await factory();

    const pooledConnection: PooledConnection<T> = {
      id,
      connection,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      inUse: false,
      requestCount: 0,
    };

    this.connections.set(id, pooledConnection);
    this.metrics.totalCreated++;
    this.metrics.idleConnections++;

    if (this.connections.size > this.metrics.peakConnections) {
      this.metrics.peakConnections = this.connections.size;
    }

    this.logger.debug('Connection created', {
      id,
      totalConnections: this.connections.size,
    });

    return pooledConnection;
  }

  private async destroyConnection(connectionId: string): Promise<void> {
    const pooledConnection = this.connections.get(connectionId);
    if (!pooledConnection) {
      return;
    }

    this.connections.delete(connectionId);
    this.metrics.totalDestroyed++;

    if (pooledConnection.inUse) {
      this.metrics.activeConnections--;
    } else {
      this.metrics.idleConnections--;
    }

    this.logger.debug('Connection destroyed', {
      connectionId,
      requestCount: pooledConnection.requestCount,
      age: Date.now() - pooledConnection.createdAt.getTime(),
    });
  }

  private markInUse(pooledConnection: PooledConnection<T>): void {
    pooledConnection.inUse = true;
    pooledConnection.lastUsedAt = new Date();
    this.metrics.activeConnections++;
    this.metrics.idleConnections--;
  }

  private async waitForConnection(
    timeout: number
  ): Promise<PooledConnection<T>> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const index = this.waitingQueue.findIndex((w) => w.resolve === resolve);
        if (index !== -1) {
          this.waitingQueue.splice(index, 1);
        }
        reject(
          new Error(
            `Connection acquire timeout after ${timeout}ms - pool exhausted`
          )
        );
      }, timeout);

      this.waitingQueue.push({
        resolve: (conn) => {
          clearTimeout(timeoutHandle);
          resolve(conn);
        },
        reject,
        requestedAt: new Date(),
      });
    });
  }

  private serveWaitingRequest(): void {
    if (this.waitingQueue.length === 0) {
      return;
    }

    const idleConnection = this.getIdleConnection();
    if (!idleConnection) {
      return;
    }

    const waiting = this.waitingQueue.shift();
    if (waiting) {
      waiting.resolve(idleConnection);
    }
  }

  private startCleanup(): void {
    // Run cleanup every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleConnections();
    }, 30000);
  }

  private async cleanupIdleConnections(): Promise<void> {
    const now = Date.now();
    const connectionsToDestroy: string[] = [];

    for (const [id, conn] of this.connections.entries()) {
      if (!conn.inUse) {
        const idleTime = now - conn.lastUsedAt.getTime();
        if (idleTime > this.config.maxIdleTime) {
          connectionsToDestroy.push(id);
        }
      }
    }

    if (connectionsToDestroy.length > 0) {
      this.logger.debug('Cleaning up idle connections', {
        count: connectionsToDestroy.length,
      });

      // Properly await all destruction operations in parallel
      await Promise.all(
        connectionsToDestroy.map((id) => this.destroyConnection(id))
      );
    }
  }

  private updateWaitTime(waitTimeMs: number): void {
    if (!this.config.enableMetrics) {
      return;
    }

    // Simple moving average
    const alpha = 0.1; // Weight for new value
    this.metrics.averageWaitTime =
      alpha * waitTimeMs + (1 - alpha) * this.metrics.averageWaitTime;
  }
}
