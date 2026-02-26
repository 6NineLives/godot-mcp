import WebSocket from 'ws';
import { logDebug, logInfo, logError, logWarn } from './logger.js';

/**
 * Response from Godot server
 */
export interface GodotResponse {
  status: 'success' | 'error';
  result?: any;
  message?: string;
  commandId?: string;
}

/**
 * Command to send to Godot
 */
export interface GodotCommand {
  type: string;
  params: Record<string, any>;
  commandId: string;
}

/**
 * Options for creating a GodotConnection.
 */
export interface GodotConnectionOptions {
  url?: string;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}

/**
 * Manages WebSocket connection to the Godot editor
 */
export class GodotConnection {
  private ws: WebSocket | null = null;
  private connected = false;
  private commandQueue: Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private commandId = 0;
  private readonly url: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private isExplicitlyDisconnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  constructor(options: GodotConnectionOptions = {}) {
    this.url = options.url ?? 'ws://localhost:9080';
    this.timeout = options.timeout ?? 20000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelay = options.retryDelay ?? 2000;
    logDebug(`GodotConnection created with base URL: ${this.url}`);
  }

  /** Try to connect to a single WebSocket URL. Returns true on success. */
  private tryConnectUrl(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        protocol: 'json',
        handshakeTimeout: 3000,
        perMessageDeflate: false,
      });

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timeout connecting to ${url}`));
      }, 4000);

      ws.once('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.connected = true;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        logInfo(`Connected to Godot WebSocket server at ${url}`);

        // Wire up persistent handlers now that we have a live socket
        ws.on('message', (data: Buffer) => {
          try {
            const response: GodotResponse = JSON.parse(data.toString());
            logDebug(`Received response: ${JSON.stringify(response)}`);
            if ('commandId' in response) {
              const cmdId = response.commandId as string;
              const pending = this.commandQueue.get(cmdId);
              if (pending) {
                clearTimeout(pending.timeout);
                this.commandQueue.delete(cmdId);
                if (response.status === 'success') pending.resolve(response.result);
                else pending.reject(new Error(response.message || 'Unknown error'));
              }
            }
          } catch (err) {
            logError(`Error parsing response: ${(err as Error).message}`);
          }
        });

        ws.on('error', (err) => logError(`WebSocket error: ${(err as Error).message}`));

        ws.on('close', () => {
          if (this.connected && !this.isExplicitlyDisconnected) {
            logWarn('Disconnected from Godot WebSocket. Reconnecting in background...');
            this.connected = false;
            this.ws = null;
            this.scheduleReconnect();
          }
        });

        resolve();
      });

      ws.once('error', (err) => {
        clearTimeout(timeout);
        ws.terminate();
        reject(err);
      });
    });
  }

  /**
   * Connects to the Godot WebSocket server.
   * Scans ports base..base+4 (e.g. 9080..9084) so it finds whichever port
   * a Godot instance has bound to, even when multiple instances are running.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.isExplicitlyDisconnected = false;

    const baseUrl = this.url;  // e.g. 'ws://localhost:9080'
    const basePort = parseInt(new URL(baseUrl).port || '9080', 10);
    const host = new URL(baseUrl).hostname;
    const MAX_PORT_SCAN = 5;  // Try 9080..9084

    // Try each port in the scan range, return on first success
    for (let p = basePort; p < basePort + MAX_PORT_SCAN; p++) {
      const url = `ws://${host}:${p}`;
      try {
        logInfo(`Trying Godot WebSocket at ${url}...`);
        await this.tryConnectUrl(url);
        return;  // Connected!
      } catch {
        logDebug(`Port ${p} not responding, trying next...`);
      }
    }

    throw new Error(
      `No Godot editor found on ports ${basePort}–${basePort + MAX_PORT_SCAN - 1}. ` +
      'Ensure the GodotMCP addon is installed and enabled in the Godot editor.'
    );
  }

  /**
   * Schedules a background reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.isExplicitlyDisconnected) return;

    // Exponential backoff: 2s, 4s, 8s, 16s, 30s max
    const baseDelay = this.retryDelay;
    const maxDelay = 30000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);

    this.reconnectAttempts++;
    logInfo(`Scheduling WebSocket reconnect in ${delay}ms (Attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        // If it fails, rely on the 'close' or error catching inside `connect` to schedule another,
        // or we just call `scheduleReconnect` again if it threw without triggering a close
        if (!this.connected && !this.isExplicitlyDisconnected) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  // Promise chain used to queue commands sequentially
  private commandQueueRunner: Promise<any> = Promise.resolve();

  /**
   * Sends a command to Godot and waits for a response.
   * Commands are run independently — one timed-out command won't block the next.
   */
  async sendCommand<T = any>(type: string, params: Record<string, any> = {}): Promise<T> {
    if (!this.ws || !this.connected) {
      try {
        await this.connect();
      } catch (error) {
        throw new Error(`${(error as Error).message}`);
      }
    }

    return new Promise<T>((resolve, reject) => {
      const cmdId = `cmd_${this.commandId++}`;

      const command: GodotCommand = {
        type,
        params,
        commandId: cmdId,
      };

      const timeoutId = setTimeout(() => {
        if (this.commandQueue.has(cmdId)) {
          this.commandQueue.delete(cmdId);
          reject(new Error(
            `Command timed out after ${this.timeout}ms: ${type}. ` +
            `Ensure Godot editor is open with the GodotMCP addon running. ` +
            `If a diff panel is showing, approve/reject it first.`
          ));
        }
      }, this.timeout);

      this.commandQueue.set(cmdId, {
        resolve,
        reject,
        timeout: timeoutId,
      });

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(command));
      } else {
        clearTimeout(timeoutId);
        this.commandQueue.delete(cmdId);
        reject(new Error(
          'WebSocket not connected. Ensure the GodotMCP addon is installed and enabled in the Godot editor.',
        ));
      }
    });
  }

  /**
   * Disconnects from the Godot WebSocket server
   */
  disconnect(): void {
    this.isExplicitlyDisconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.commandQueue.forEach((command) => {
        clearTimeout(command.timeout);
        command.reject(new Error('Connection closed'));
      });
      this.commandQueue.clear();

      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  /**
   * Checks if connected to Godot
   */
  isConnected(): boolean {
    return this.connected;
  }
}

// Singleton instance
let connectionInstance: GodotConnection | null = null;

/**
 * Gets the singleton instance of GodotConnection,
 * initialized with config values if available.
 */
export function getGodotConnection(options?: GodotConnectionOptions): GodotConnection {
  if (!connectionInstance) {
    connectionInstance = new GodotConnection(options);
  }
  return connectionInstance;
}

/**
 * Reset the singleton (useful for testing or config changes).
 */
export function resetGodotConnection(): void {
  if (connectionInstance) {
    connectionInstance.disconnect();
    connectionInstance = null;
  }
}