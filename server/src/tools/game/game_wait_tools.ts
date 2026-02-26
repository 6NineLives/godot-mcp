/**
 * Game wait tools — wait for game conditions before proceeding.
 *
 * Single consolidated tool: `game_wait`
 * Actions: node | property | signal | condition
 */

import { z } from 'zod';
import { MCPTool } from '../../utils/types.js';
import { getGameBridge } from '../../core/game_bridge.js';
import { loadConfig } from '../../config/config.js';

export const gameWaitTools: MCPTool[] = [
    {
        name: 'game_wait',
        description:
            'Wait for conditions in a running Godot game before proceeding (via the game bridge). ' +
            'Actions: "node" waits until a node exists at a path, ' +
            '"property" waits until a node property reaches a target value, ' +
            '"signal" waits for a signal to be emitted, ' +
            '"condition" waits for a GDScript expression to be truthy (requires allowUnsafeGameCommands).',
        parameters: z.object({
            action: z
                .enum(['node', 'property', 'signal', 'condition'])
                .describe('Which wait action to perform'),
            nodePath: z.string().optional().describe(
                'Path to the target node. Required for: node, property, signal.'
            ),
            property: z.string().optional().describe(
                'Property name to watch. Required for: property.'
            ),
            expected: z.any().optional().describe(
                'Expected property value. Required for: property.'
            ),
            signalName: z.string().optional().describe(
                'Signal name to wait for (e.g. "body_entered"). Required for: signal.'
            ),
            expression: z.string().optional().describe(
                'GDScript expression that must be truthy (e.g. "$Player.health > 0"). Required for: condition.'
            ),
            timeoutMs: z.number().optional().describe(
                'Maximum wait time in ms (default: 5000). Used for all actions.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;
            const bridge = getGameBridge();
            const config = loadConfig();
            const timeoutMs = (params.timeoutMs as number) ?? 5000;

            if (!bridge.isConnected()) {
                throw new Error('Not connected to game bridge. Use manage_game_bridge action "connect" first.');
            }

            try {
                switch (action) {
                    case 'node': {
                        const nodePath = params.nodePath as string;
                        if (!nodePath) throw new Error('nodePath is required for action "node"');

                        const result = await bridge.sendCommand('wait_for_node', {
                            node_path: nodePath,
                            timeout_ms: timeoutMs,
                        });

                        if (result.timed_out) {
                            return `⏱️ Timed out waiting for node: ${nodePath} (${timeoutMs}ms)`;
                        }
                        return `✅ Node found: ${nodePath}`;
                    }

                    case 'property': {
                        const nodePath = params.nodePath as string;
                        const property = params.property as string;
                        if (!nodePath) throw new Error('nodePath is required for action "property"');
                        if (!property) throw new Error('property is required for action "property"');

                        const result = await bridge.sendCommand('wait_for_property', {
                            node_path: nodePath,
                            property,
                            expected: params.expected,
                            timeout_ms: timeoutMs,
                        });

                        if (result.timed_out) {
                            return `⏱️ Timed out waiting for ${nodePath}.${property} == ${JSON.stringify(params.expected)} (${timeoutMs}ms)`;
                        }
                        return `✅ Property matched: ${nodePath}.${property} = ${JSON.stringify(result.value)}`;
                    }

                    case 'signal': {
                        const nodePath = params.nodePath as string;
                        const signalName = params.signalName as string;
                        if (!nodePath) throw new Error('nodePath is required for action "signal"');
                        if (!signalName) throw new Error('signalName is required for action "signal"');

                        const result = await bridge.sendCommand('wait_for_signal', {
                            node_path: nodePath,
                            signal_name: signalName,
                            timeout_ms: timeoutMs,
                        });

                        if (result.timed_out) {
                            return `⏱️ Timed out waiting for signal "${signalName}" on ${nodePath} (${timeoutMs}ms)`;
                        }
                        return `✅ Signal received: "${signalName}" on ${nodePath}`;
                    }

                    case 'condition': {
                        if (!config.allowUnsafeGameCommands) {
                            throw new Error(
                                'condition requires "allowUnsafeGameCommands": true in godot-mcp.config.json'
                            );
                        }

                        const expression = params.expression as string;
                        if (!expression) throw new Error('expression is required for action "condition"');

                        const result = await bridge.sendCommand('wait_for_condition', {
                            expression,
                            timeout_ms: timeoutMs,
                        });

                        if (result.timed_out) {
                            return `⏱️ Timed out waiting for condition: ${expression} (${timeoutMs}ms)`;
                        }
                        return `✅ Condition met: ${expression}`;
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Game wait action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
