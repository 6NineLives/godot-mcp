/**
 * HTTP + WebSocket server for the project visualization.
 *
 * Architecture:
 *   1. `serveVisualization()` is called with project data from visualizer_tools.ts
 *   2. The bundled `dist/visualizer.html` is read and `%%PROJECT_DATA%%` is replaced
 *      with the actual JSON data (this placeholder lives inside the esbuild bundle)
 *   3. An HTTP server serves the single-file HTML
 *   4. A WebSocket server handles real-time commands from the browser frontend
 *   5. Commands are forwarded to Godot via `GodotConnection.sendCommand()`
 *
 * The frontend uses commands like `refresh_map`, `modify_variable`, `open_script`,
 * etc. Some map to `visualizer._internal_*` GDScript handlers, others to existing
 * editor commands.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { getGodotConnection } from './godot_connection.js';
import { logInfo, logError } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let vizServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
const DEFAULT_PORT = 6510;

// ---------------------------------------------------------------------------
// Commands that map to top-level GDScript commands (not _internal_ prefixed)
// ---------------------------------------------------------------------------
const TOP_LEVEL_COMMAND_MAP: Record<string, string> = {
    refresh_map: 'map_project_scripts',
    map_scenes: 'map_project_scenes',
};

// Commands that should be routed to existing editor command processors
const EDITOR_COMMAND_MAP: Record<string, string> = {
    open_script: 'open_script_in_editor',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serve the visualization and open the browser.
 * Closes any previous instance before starting a new one.
 * @returns The URL where the visualizer is hosted.
 */
export async function serveVisualization(projectData: unknown): Promise<string> {
    // Close previous instance if running
    await stopVisualizationServer();

    // The bundled HTML lives at dist/visualizer.html (sibling of dist/utils/)
    const htmlPath = path.join(__dirname, '..', 'visualizer.html');

    let html: string;
    try {
        html = fs.readFileSync(htmlPath, 'utf-8');
    } catch {
        throw new Error(
            `Visualizer HTML not found at ${htmlPath}. ` +
            'Run "npm run build" to generate it.',
        );
    }

    // Inject project data into the bundled script
    // The esbuild bundle contains `"%%PROJECT_DATA%%"` as a string literal in state.js
    const dataJson = JSON.stringify(projectData);
    html = html.replace('"%%PROJECT_DATA%%"', dataJson);

    const port = await findAvailablePort(DEFAULT_PORT);

    return new Promise((resolve, reject) => {
        vizServer = http.createServer((_req, res) => {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache',
            });
            res.end(html);
        });

        wss = new WebSocketServer({ server: vizServer });
        wss.on('connection', handleConnection);

        vizServer.on('error', (err) => {
            reject(new Error(`Failed to start visualizer server: ${err.message}`));
        });

        vizServer.listen(port, () => {
            const url = `http://localhost:${port}`;
            logInfo(`[visualizer] Serving at ${url}`);
            openBrowser(url);
            resolve(url);
        });
    });
}

/**
 * Stop the visualization server if running.
 */
export async function stopVisualizationServer(): Promise<void> {
    if (wss) {
        wss.close();
        wss = null;
    }
    if (vizServer) {
        await new Promise<void>((resolve) => {
            vizServer!.close(() => resolve());
        });
        vizServer = null;
        logInfo('[visualizer] Server stopped');
    }
}

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------

function handleConnection(ws: WebSocket): void {
    logInfo('[visualizer] Browser connected via WebSocket');

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            const result = await routeCommand(message);
            ws.send(JSON.stringify(
                message.id ? { id: message.id, ...result } : result,
            ));
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            ws.send(JSON.stringify({ error: errMsg }));
        }
    });

    ws.on('close', () => {
        logInfo('[visualizer] Browser disconnected');
    });
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

interface VisualizerMessage {
    id?: number;
    type?: string;          // always 'visualizer_command' from websocket.js
    command: string;
    args: Record<string, unknown>;
}

interface CommandResponse {
    ok: boolean;
    error?: string;
    [key: string]: unknown;
}

/**
 * Route a command from the browser to the correct GDScript handler.
 *
 * Three categories:
 *   1. Top-level commands (refresh_map, map_scenes) → forwarded as-is to
 *      their existing GDScript command names
 *   2. Editor commands (open_script) → forwarded to editor command processors
 *   3. Internal commands (modify_variable, modify_function, etc.) → prefixed
 *      with `visualizer._internal_` and forwarded to visualizer_commands.gd
 */
async function routeCommand(message: VisualizerMessage): Promise<CommandResponse> {
    const { command, args } = message;
    const connection = getGodotConnection();

    if (!connection.isConnected()) {
        return { ok: false, error: 'Godot is not connected' };
    }

    logInfo(`[visualizer] Command: ${command}`);

    try {
        let godotCommand: string;

        if (command in TOP_LEVEL_COMMAND_MAP) {
            // Category 1: top-level commands
            godotCommand = TOP_LEVEL_COMMAND_MAP[command];
        } else if (command in EDITOR_COMMAND_MAP) {
            // Category 2: editor commands
            godotCommand = EDITOR_COMMAND_MAP[command];
        } else {
            // Category 3: internal visualizer commands
            godotCommand = `visualizer._internal_${command}`;
        }

        const result = await connection.sendCommand(godotCommand, args);

        // Normalize response — ensure `ok` field exists
        if (result && typeof result === 'object' && !('ok' in result)) {
            return { ok: true, ...(result as Record<string, unknown>) };
        }
        return result as CommandResponse;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        logError(`[visualizer] Command "${command}" failed: ${errMsg}`);
        return { ok: false, error: errMsg };
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function findAvailablePort(startPort: number): Promise<number> {
    return new Promise((resolve) => {
        const server = http.createServer();
        server.listen(startPort, () => {
            server.close(() => resolve(startPort));
        });
        server.on('error', () => {
            resolve(findAvailablePort(startPort + 1));
        });
    });
}

function openBrowser(url: string): void {
    const cmd =
        process.platform === 'darwin' ? 'open' :
            process.platform === 'win32' ? 'start' :
                'xdg-open';

    exec(`${cmd} ${url}`, (err) => {
        if (err) {
            logError(`[visualizer] Could not open browser: ${err.message}`);
        }
    });
}
