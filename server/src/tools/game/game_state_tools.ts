/**
 * Game state tools — query running game state.
 *
 * Single consolidated tool: `game_state`
 * Actions: get_singleton | evaluate | get_performance | get_viewport
 */

import { z } from 'zod';
import { MCPTool } from '../../utils/types.js';
import { getGameBridge } from '../../core/game_bridge.js';
import { loadConfig } from '../../config/config.js';

export const gameStateTools: MCPTool[] = [
    {
        name: 'game_state',
        description:
            'Query the state of a running Godot game (via the game bridge). ' +
            'Actions: "get_singleton" to read properties from an autoload/singleton, ' +
            '"evaluate" to evaluate a GDScript expression (requires allowUnsafeGameCommands), ' +
            '"get_performance" to get engine performance metrics (FPS, memory, draw calls), ' +
            '"get_viewport" to get viewport size and camera info.',
        parameters: z.object({
            action: z
                .enum(['get_singleton', 'evaluate', 'get_performance', 'get_viewport'])
                .describe('Which state query to perform'),
            name: z.string().optional().describe(
                'Singleton or autoload name (e.g. "GameManager"). Required for: get_singleton.'
            ),
            filter: z.array(z.string()).optional().describe(
                'List of property names to return (default: all). Used for: get_singleton.'
            ),
            expression: z.string().optional().describe(
                'GDScript expression to evaluate (e.g. "$Player.health"). Required for: evaluate.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;
            const bridge = getGameBridge();
            const config = loadConfig();

            if (!bridge.isConnected()) {
                throw new Error('Not connected to game bridge. Use manage_game_bridge action "connect" first.');
            }

            try {
                switch (action) {
                    case 'get_singleton': {
                        const name = params.name as string;
                        if (!name) throw new Error('name is required for action "get_singleton"');

                        // Validate no path traversal
                        if (name.includes('..') || name.includes('/')) {
                            throw new Error('Invalid singleton name (path traversal detected)');
                        }

                        const result = await bridge.sendCommand('get_singleton', {
                            name,
                            filter: (params.filter as string[]) || [],
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    case 'evaluate': {
                        if (!config.allowUnsafeGameCommands) {
                            throw new Error(
                                'evaluate requires "allowUnsafeGameCommands": true in godot-mcp.config.json'
                            );
                        }

                        const expression = params.expression as string;
                        if (!expression) throw new Error('expression is required for action "evaluate"');

                        const result = await bridge.sendCommand('evaluate_expression', {
                            expression,
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    case 'get_performance': {
                        const result = await bridge.sendCommand('get_performance_metrics', {});
                        return JSON.stringify(result, null, 2);
                    }

                    case 'get_viewport': {
                        const result = await bridge.sendCommand('get_viewport_info', {});
                        return JSON.stringify(result, null, 2);
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Game state action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
