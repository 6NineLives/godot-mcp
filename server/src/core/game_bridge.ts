/**
 * WebSocket client for connecting to a running Godot game's test bridge.
 *
 * The game bridge runs inside the game process as an autoload (`test_bridge.gd`)
 * on a separate port (default 9081) from the editor addon (9080).
 *
 * Uses JSON-RPC framing to send commands and receive responses.
 */

import WebSocket from 'ws';
import { logDebug, logInfo, logError, logWarn } from '../utils/logger.js';
import { loadConfig } from '../config/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeResponse {
    jsonrpc: '2.0';
    id: string;
    result?: any;
    error?: { code: number; message: string; data?: any };
}

export interface BridgeRequest {
    jsonrpc: '2.0';
    id: string;
    method: string;
    params?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// GameBridge class
// ---------------------------------------------------------------------------

export class GameBridge {
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

    constructor(url?: string, timeout?: number) {
        const config = loadConfig();
        this.url = url ?? config.gameBridgeUrl;
        this.timeout = timeout ?? config.commandTimeout;
        logDebug(`GameBridge created with URL: ${this.url}`);
    }

    /** Connect to the game bridge WebSocket server. */
    async connect(url?: string): Promise<void> {
        const targetUrl = url ?? this.url;

        if (this.connected && this.ws) {
            logDebug('GameBridge already connected');
            return;
        }

        return new Promise<void>((resolve, reject) => {
            logInfo(`Connecting to game bridge at ${targetUrl}...`);

            this.ws = new WebSocket(targetUrl, {
                handshakeTimeout: 5000,
                perMessageDeflate: false,
            });

            const connectionTimeout = setTimeout(() => {
                if (this.ws?.readyState !== WebSocket.OPEN) {
                    this.ws?.terminate();
                    this.ws = null;
                    reject(new Error(`Game bridge connection timeout (${targetUrl})`));
                }
            }, 10000);

            this.ws.on('open', () => {
                clearTimeout(connectionTimeout);
                this.connected = true;
                logInfo(`Connected to game bridge at ${targetUrl}`);
                resolve();
            });

            this.ws.on('message', (data: Buffer) => {
                try {
                    const response: BridgeResponse = JSON.parse(data.toString());
                    logDebug(`Bridge response: ${JSON.stringify(response)}`);

                    if (response.id) {
                        const pending = this.commandQueue.get(response.id);
                        if (pending) {
                            clearTimeout(pending.timeout);
                            this.commandQueue.delete(response.id);

                            if (response.error) {
                                pending.reject(new Error(response.error.message));
                            } else {
                                pending.resolve(response.result);
                            }
                        }
                    }
                } catch (error) {
                    logError(`Error parsing bridge response: ${(error as Error).message}`);
                }
            });

            this.ws.on('error', (error) => {
                clearTimeout(connectionTimeout);
                logError(`Bridge WebSocket error: ${(error as Error).message}`);
                if (!this.connected) {
                    reject(new Error(`Game bridge connection failed: ${(error as Error).message}. Is the game running with test_bridge.gd?`));
                }
            });

            this.ws.on('close', () => {
                if (this.connected) {
                    logWarn('Disconnected from game bridge');
                }
                this.connected = false;
                this.ws = null;
            });
        });
    }

    /** Send a JSON-RPC command to the game and wait for a response. */
    async sendCommand<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
        if (!this.ws || !this.connected) {
            throw new Error(
                'Not connected to game bridge. Use manage_game_bridge with action "connect" first, ' +
                'or "run" to launch the game with the bridge.'
            );
        }

        return new Promise<T>((resolve, reject) => {
            const id = `bridge_${this.commandId++}`;

            const request: BridgeRequest = {
                jsonrpc: '2.0',
                id,
                method,
                params,
            };

            const timeoutId = setTimeout(() => {
                if (this.commandQueue.has(id)) {
                    this.commandQueue.delete(id);
                    reject(new Error(`Bridge command timed out after ${this.timeout}ms: ${method}`));
                }
            }, this.timeout);

            this.commandQueue.set(id, { resolve, reject, timeout: timeoutId });

            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(request));
            } else {
                clearTimeout(timeoutId);
                this.commandQueue.delete(id);
                reject(new Error('Game bridge WebSocket not open'));
            }
        });
    }

    /** Disconnect from the game bridge. */
    disconnect(): void {
        if (this.ws) {
            this.commandQueue.forEach((cmd) => {
                clearTimeout(cmd.timeout);
                cmd.reject(new Error('Bridge connection closed'));
            });
            this.commandQueue.clear();

            this.ws.close();
            this.ws = null;
            this.connected = false;
            logInfo('Disconnected from game bridge');
        }
    }

    /** Check if connected to the game bridge. */
    isConnected(): boolean {
        return this.connected;
    }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let bridgeInstance: GameBridge | null = null;

/** Get the singleton GameBridge instance. */
export function getGameBridge(): GameBridge {
    if (!bridgeInstance) {
        bridgeInstance = new GameBridge();
    }
    return bridgeInstance;
}

/** Reset the singleton (cleanup or config changes). */
export function resetGameBridge(): void {
    if (bridgeInstance) {
        bridgeInstance.disconnect();
        bridgeInstance = null;
    }
}
