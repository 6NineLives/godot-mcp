/**
 * Signal tools — inspecting and managing Godot signals.
 *
 * Single consolidated tool: `manage_signal`
 * Actions: list | connect | disconnect | create
 *
 * Operates on .tscn and .gd files directly (headless, no WebSocket).
 */

import { z } from 'zod';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { MCPTool } from '../../utils/types.js';
import {
    validatePath,
    isGodotProject,
    detectProjectPath,
} from '../../core/path-manager.js';
import { logInfo } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SignalConnection {
    signal: string;
    from: string;
    to: string;
    method: string;
    flags?: number;
}

function parseSignalConnections(content: string): SignalConnection[] {
    const connections: SignalConnection[] = [];
    const regex =
        /\[connection\s+signal="([^"]+)"\s+from="([^"]+)"\s+to="([^"]+)"\s+method="([^"]+)"(?:\s+flags=(\d+))?\]/g;

    let match;
    while ((match = regex.exec(content)) !== null) {
        connections.push({
            signal: match[1],
            from: match[2],
            to: match[3],
            method: match[4],
            flags: match[5] ? parseInt(match[5], 10) : undefined,
        });
    }
    return connections;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const signalTools: MCPTool[] = [
    {
        name: 'manage_signal',
        description:
            'Manage Godot signals in scenes and scripts. ' +
            'Actions: "list" to list signal connections in a .tscn file, ' +
            '"connect" to add a signal connection to a .tscn file, ' +
            '"disconnect" to remove a signal connection from a .tscn file, ' +
            '"create" to add a custom signal declaration to a .gd script.',
        parameters: z.object({
            action: z
                .enum(['list', 'connect', 'disconnect', 'create'])
                .describe('Which signal action to perform'),
            projectPath: z.string().describe('Absolute path to the Godot project directory'),
            scenePath: z.string().optional().describe(
                'Scene file (relative to project root, e.g. "scenes/main.tscn"). ' +
                'Required for: list, connect, disconnect.'
            ),
            scriptPath: z.string().optional().describe(
                'Script file (relative to project root, e.g. "scripts/player.gd"). ' +
                'Required for: create.'
            ),
            signal: z.string().optional().describe(
                'Signal name (e.g. "pressed", "body_entered"). Required for: connect, disconnect.'
            ),
            from: z.string().optional().describe(
                'Source node path within the scene (e.g. "Button", "Area2D"). Required for: connect, disconnect.'
            ),
            to: z.string().optional().describe(
                'Target node path within the scene (e.g. ".", "Player"). Required for: connect, disconnect.'
            ),
            method: z.string().optional().describe(
                'Method to call on the target node (e.g. "_on_button_pressed"). Required for: connect, disconnect.'
            ),
            signalName: z.string().optional().describe(
                'Name of the signal to create (e.g. "health_changed"). Required for: create.'
            ),
            parameters: z.string().optional().describe(
                'Optional typed parameters for a new signal (e.g. "new_health: int, old_health: int"). Used for: create.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;
            const projectPath = params.projectPath as string;

            const resolvedPath = detectProjectPath(projectPath);
            if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
            if (!isGodotProject(resolvedPath))
                throw new Error(`Not a Godot project: ${resolvedPath} (resolved from ${projectPath})`);

            try {
                switch (action) {
                    // -----------------------------------------------------------
                    case 'list': {
                        const scenePath = params.scenePath as string;
                        if (!scenePath) throw new Error('scenePath is required for action "list"');

                        const normalizedScene = scenePath.replace(/^res:\/\//, '');
                        const fullPath = join(resolvedPath, normalizedScene);
                        if (!existsSync(fullPath)) throw new Error(`Scene file not found: ${normalizedScene}`);

                        logInfo(`manage_signal/list: parsing ${normalizedScene}`);
                        const content = readFileSync(fullPath, 'utf8');
                        const connections = parseSignalConnections(content);

                        // Also extract custom signal declarations from referenced scripts
                        const customSignals: string[] = [];
                        const scriptMatches = content.match(/path="(res:\/\/[^"]+\.gd)"/g);
                        if (scriptMatches) {
                            for (const m of scriptMatches) {
                                const sp = m.match(/path="(res:\/\/[^"]+\.gd)"/)?.[1]?.replace(/^res:\/\//, '');
                                if (sp) {
                                    const scriptFullPath = join(resolvedPath, sp);
                                    if (existsSync(scriptFullPath)) {
                                        try {
                                            const sc = readFileSync(scriptFullPath, 'utf8');
                                            const decls = sc.match(/^signal\s+(\w+)/gm);
                                            if (decls) {
                                                for (const d of decls) {
                                                    customSignals.push(`${sp}: ${d.replace(/^signal\s+/, '').trim()}`);
                                                }
                                            }
                                        } catch { /* skip unreadable */ }
                                    }
                                }
                            }
                        }

                        return JSON.stringify({
                            scene: normalizedScene,
                            connectionCount: connections.length,
                            connections,
                            customSignals: customSignals.length > 0 ? customSignals : undefined,
                        }, null, 2);
                    }

                    // -----------------------------------------------------------
                    case 'connect': {
                        const scenePath = params.scenePath as string;
                        const signal = params.signal as string;
                        const from = params.from as string;
                        const to = params.to as string;
                        const method = params.method as string;
                        if (!scenePath) throw new Error('scenePath is required for action "connect"');
                        if (!signal || !from || !to || !method)
                            throw new Error('signal, from, to, and method are all required for action "connect"');

                        const normalizedScene = scenePath.replace(/^res:\/\//, '');
                        const fullPath = join(resolvedPath, normalizedScene);
                        if (!existsSync(fullPath)) throw new Error(`Scene file not found: ${normalizedScene}`);

                        logInfo(`manage_signal/connect: ${signal} from "${from}" to "${to}".${method} in ${normalizedScene}`);
                        let content = readFileSync(fullPath, 'utf8');

                        // Check for duplicate
                        const existing = parseSignalConnections(content);
                        const isDup = existing.some(c => c.signal === signal && c.from === from && c.to === to && c.method === method);
                        if (isDup) {
                            return JSON.stringify({ success: false, message: `Connection already exists: ${signal} from "${from}" to "${to}".${method}` });
                        }

                        const connectionLine = `[connection signal="${signal}" from="${from}" to="${to}" method="${method}"]`;
                        if (!content.endsWith('\n')) content += '\n';
                        content += '\n' + connectionLine + '\n';
                        writeFileSync(fullPath, content, 'utf8');

                        return JSON.stringify({
                            success: true,
                            message: `✅ Connected signal "${signal}" from "${from}" to "${to}".${method}()`,
                            scene: normalizedScene,
                            connection: { signal, from, to, method },
                        });
                    }

                    // -----------------------------------------------------------
                    case 'disconnect': {
                        const scenePath = params.scenePath as string;
                        const signal = params.signal as string;
                        const from = params.from as string;
                        const to = params.to as string;
                        const method = params.method as string;
                        if (!scenePath) throw new Error('scenePath is required for action "disconnect"');
                        if (!signal || !from || !to || !method)
                            throw new Error('signal, from, to, and method are all required for action "disconnect"');

                        const normalizedScene = scenePath.replace(/^res:\/\//, '');
                        const fullPath = join(resolvedPath, normalizedScene);
                        if (!existsSync(fullPath)) throw new Error(`Scene file not found: ${normalizedScene}`);

                        logInfo(`manage_signal/disconnect: ${signal} from "${from}" to "${to}".${method} in ${normalizedScene}`);
                        const content = readFileSync(fullPath, 'utf8');

                        const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const connectionRegex = new RegExp(
                            `\\n?\\[connection\\s+signal="${esc(signal)}"\\s+from="${esc(from)}"\\s+to="${esc(to)}"\\s+method="${esc(method)}"(?:\\s+flags=\\d+)?\\]\\n?`,
                            'g',
                        );

                        const newContent = content.replace(connectionRegex, '\n');
                        if (newContent === content) {
                            return JSON.stringify({ success: false, message: `No matching connection found: ${signal} from "${from}" to "${to}".${method}` });
                        }

                        writeFileSync(fullPath, newContent.replace(/\n{3,}/g, '\n\n'), 'utf8');
                        return JSON.stringify({
                            success: true,
                            message: `✅ Disconnected signal "${signal}" from "${from}" to "${to}".${method}()`,
                            scene: normalizedScene,
                            disconnected: { signal, from, to, method },
                        });
                    }

                    // -----------------------------------------------------------
                    case 'create': {
                        const scriptPath = params.scriptPath as string;
                        const signalName = params.signalName as string;
                        if (!scriptPath) throw new Error('scriptPath is required for action "create"');
                        if (!signalName) throw new Error('signalName is required for action "create"');

                        const normalizedScript = scriptPath.replace(/^res:\/\//, '');
                        const fullPath = join(resolvedPath, normalizedScript);
                        if (!existsSync(fullPath)) throw new Error(`Script file not found: ${normalizedScript}`);

                        logInfo(`manage_signal/create: adding signal "${signalName}" to ${normalizedScript}`);
                        const content = readFileSync(fullPath, 'utf8');
                        const lines = content.split('\n');

                        const sigRegex = new RegExp(`^signal\\s+${signalName}\\b`, 'm');
                        if (sigRegex.test(content)) {
                            return JSON.stringify({ success: false, message: `Signal "${signalName}" already exists in ${normalizedScript}` });
                        }

                        const sigParams = params.parameters as string | undefined;
                        const signalDecl = sigParams ? `signal ${signalName}(${sigParams})` : `signal ${signalName}`;

                        let insertIndex = 0;
                        for (let i = 0; i < lines.length; i++) {
                            const trimmed = lines[i].trim();
                            if (trimmed.startsWith('signal ')) {
                                insertIndex = i + 1;
                            } else if (insertIndex === 0 && (trimmed.startsWith('extends ') || trimmed.startsWith('class_name '))) {
                                insertIndex = i + 1;
                            }
                        }

                        lines.splice(insertIndex, 0, signalDecl);
                        writeFileSync(fullPath, lines.join('\n'), 'utf8');

                        return JSON.stringify({
                            success: true,
                            message: `✅ Added signal "${signalName}" to ${normalizedScript} at line ${insertIndex + 1}`,
                            script: normalizedScript,
                            declaration: signalDecl,
                            line: insertIndex + 1,
                        });
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Signal action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
