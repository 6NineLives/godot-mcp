/**
 * Game Bridge management tool — connection lifecycle & project launch.
 *
 * Single consolidated tool: `manage_game_bridge`
 * Actions: connect | disconnect | status | install | run
 */

import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { MCPTool } from '../../utils/types.js';
import { getGameBridge, resetGameBridge } from '../../core/game_bridge.js';
import { detectGodotPath, detectProjectPath, isGodotProject, validatePath } from '../../core/path-manager.js';
import { loadConfig } from '../../config/config.js';
import { logInfo, logError } from '../../utils/logger.js';
import { getProcessManager } from '../../core/process-manager.js';

const execFileAsync = promisify(execFile);

// Resolve script path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getBridgeScriptPath(): string {
    // __dirname at runtime = dist/tools/game/ — go up two levels to reach dist/scripts/
    return join(__dirname, '..', '..', 'scripts', 'test_bridge.gd');
}

export const gameBridgeTools: MCPTool[] = [
    {
        name: 'manage_game_bridge',
        description:
            'Manage the E2E game testing bridge. ' +
            'Actions: "connect" to connect to a running game bridge, ' +
            '"disconnect" to close the connection, ' +
            '"status" to check bridge connection state, ' +
            '"install" to register test_bridge.gd as an autoload in the project, ' +
            '"run" to launch the game with the bridge and auto-connect.',
        parameters: z.object({
            action: z
                .enum(['connect', 'disconnect', 'status', 'install', 'run'])
                .describe('Which bridge action to perform'),
            projectPath: z.string().optional().describe(
                'Absolute path to the Godot project. Required for: install, run.'
            ),
            url: z.string().optional().describe(
                'WebSocket URL to connect to (default: ws://localhost:9081). Used for: connect.'
            ),
            scenePath: z.string().optional().describe(
                'Scene to launch when running (e.g. "res://main.tscn"). Used for: run.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;
            const config = loadConfig();

            try {
                switch (action) {
                    case 'connect': {
                        const url = (params.url as string) || config.gameBridgeUrl;
                        const bridge = getGameBridge();
                        await bridge.connect(url);
                        return `✅ Connected to game bridge at ${url}`;
                    }

                    case 'disconnect': {
                        resetGameBridge();
                        return '✅ Disconnected from game bridge';
                    }

                    case 'status': {
                        const bridge = getGameBridge();
                        const connected = bridge.isConnected();

                        if (connected) {
                            try {
                                const ping = await bridge.sendCommand('ping', {});
                                return JSON.stringify({
                                    connected: true,
                                    scene: ping.scene || 'unknown',
                                    message: '✅ Game bridge is connected and responding',
                                }, null, 2);
                            } catch {
                                return JSON.stringify({
                                    connected: true,
                                    message: '⚠️ Connected but ping failed',
                                }, null, 2);
                            }
                        }

                        return JSON.stringify({
                            connected: false,
                            message: 'Not connected. Use action "connect" or "run" to connect.',
                        }, null, 2);
                    }

                    case 'install': {
                        const projectPath = params.projectPath as string;
                        if (!projectPath) throw new Error('projectPath is required for action "install"');

                        const resolvedPath = detectProjectPath(projectPath);
                        if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
                        if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath}`);

                        // Copy test_bridge.gd to the project
                        const srcScript = getBridgeScriptPath();
                        if (!existsSync(srcScript)) {
                            throw new Error(`Bridge script not found: ${srcScript}. Rebuild the server.`);
                        }

                        const destScript = join(resolvedPath, 'test_bridge.gd');
                        copyFileSync(srcScript, destScript);
                        logInfo(`Copied test_bridge.gd → ${destScript}`);

                        // Register as autoload in project.godot
                        const projectFile = join(resolvedPath, 'project.godot');
                        let content = readFileSync(projectFile, 'utf8');

                        if (content.includes('TestBridge')) {
                            return '✅ TestBridge autoload already registered in project.godot';
                        }

                        // Find or create [autoload] section
                        if (content.includes('[autoload]')) {
                            content = content.replace(
                                '[autoload]',
                                '[autoload]\n\nTestBridge="*res://test_bridge.gd"'
                            );
                        } else {
                            content += '\n\n[autoload]\n\nTestBridge="*res://test_bridge.gd"\n';
                        }

                        writeFileSync(projectFile, content, 'utf8');
                        return '✅ TestBridge autoload installed in project.godot. The bridge will start when the game runs.';
                    }

                    case 'run': {
                        const projectPath = params.projectPath as string;
                        if (!projectPath) throw new Error('projectPath is required for action "run"');

                        const resolvedPath = detectProjectPath(projectPath);
                        if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
                        if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath}`);

                        const godotPath = await detectGodotPath();
                        if (!godotPath) throw new Error('Godot not found');

                        // Make sure the bridge is installed
                        const destScript = join(resolvedPath, 'test_bridge.gd');
                        if (!existsSync(destScript)) {
                            const srcScript = getBridgeScriptPath();
                            if (existsSync(srcScript)) {
                                copyFileSync(srcScript, destScript);
                            }
                        }

                        // Build launch args
                        const args = ['--path', resolvedPath];
                        const scenePath = params.scenePath as string;
                        if (scenePath) {
                            args.push(scenePath);
                        }

                        logInfo(`Launching game: ${godotPath} ${args.join(' ')}`);

                        // Launch non-blocking
                        const { spawn } = await import('child_process');
                        const child = spawn(godotPath, args, {
                            cwd: resolvedPath,
                            detached: true,
                            stdio: 'ignore',
                        });
                        child.unref();

                        // Wait for bridge to come up, then connect
                        await new Promise(resolve => setTimeout(resolve, 3000));

                        try {
                            const bridge = getGameBridge();
                            await bridge.connect();
                            return `✅ Game launched and bridge connected (PID: ${child.pid})`;
                        } catch {
                            return `⚠️ Game launched (PID: ${child.pid}) but bridge not yet ready. Try "connect" in a few seconds.`;
                        }
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Bridge action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
