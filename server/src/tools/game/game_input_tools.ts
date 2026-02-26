/**
 * Game input tools — simulate player input in a running Godot game.
 *
 * Single consolidated tool: `game_input`
 * Actions: key | mouse_click | mouse_drag | text
 */

import { z } from 'zod';
import { MCPTool } from '../../utils/types.js';
import { getGameBridge } from '../../core/game_bridge.js';

export const gameInputTools: MCPTool[] = [
    {
        name: 'game_input',
        description:
            'Simulate player input in a running Godot game (via the game bridge). ' +
            'Actions: "key" to press/release a key or action, ' +
            '"mouse_click" to click at a position, ' +
            '"mouse_drag" to drag from one position to another, ' +
            '"text" to type a string character-by-character.',
        parameters: z.object({
            action: z
                .enum(['key', 'mouse_click', 'mouse_drag', 'text'])
                .describe('Which input action to simulate'),
            key: z.string().optional().describe(
                'Key name (e.g. "W", "Space") or action name (e.g. "ui_accept"). Required for: key.'
            ),
            pressed: z.boolean().optional().describe(
                'Whether the key is pressed (true) or released (false). Default: true. Used for: key.'
            ),
            durationMs: z.number().optional().describe(
                'Hold duration in ms (default: 100). Used for: key.'
            ),
            x: z.number().optional().describe(
                'X coordinate for click. Required for: mouse_click.'
            ),
            y: z.number().optional().describe(
                'Y coordinate for click. Required for: mouse_click.'
            ),
            button: z.number().optional().describe(
                'Mouse button (1=left, 2=right, 3=middle). Default: 1. Used for: mouse_click, mouse_drag.'
            ),
            doubleClick: z.boolean().optional().describe(
                'Whether to double-click. Default: false. Used for: mouse_click.'
            ),
            fromX: z.number().optional().describe('Drag start X. Required for: mouse_drag.'),
            fromY: z.number().optional().describe('Drag start Y. Required for: mouse_drag.'),
            toX: z.number().optional().describe('Drag end X. Required for: mouse_drag.'),
            toY: z.number().optional().describe('Drag end Y. Required for: mouse_drag.'),
            steps: z.number().optional().describe(
                'Number of interpolation steps for drag (default: 10). Used for: mouse_drag.'
            ),
            text: z.string().optional().describe(
                'Text string to type. Required for: text.'
            ),
            delayMs: z.number().optional().describe(
                'Delay between characters in ms (default: 50). Used for: text.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;
            const bridge = getGameBridge();

            if (!bridge.isConnected()) {
                throw new Error('Not connected to game bridge. Use manage_game_bridge action "connect" first.');
            }

            try {
                switch (action) {
                    case 'key': {
                        const key = params.key as string;
                        if (!key) throw new Error('key is required for action "key"');

                        const result = await bridge.sendCommand('send_key', {
                            key,
                            pressed: (params.pressed as boolean) ?? true,
                            duration_ms: (params.durationMs as number) ?? 100,
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    case 'mouse_click': {
                        const x = params.x as number;
                        const y = params.y as number;
                        if (x === undefined || y === undefined) {
                            throw new Error('x and y are required for action "mouse_click"');
                        }

                        const result = await bridge.sendCommand('send_mouse_click', {
                            x, y,
                            button: (params.button as number) ?? 1,
                            double_click: (params.doubleClick as boolean) ?? false,
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    case 'mouse_drag': {
                        const fromX = params.fromX as number;
                        const fromY = params.fromY as number;
                        const toX = params.toX as number;
                        const toY = params.toY as number;

                        if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
                            throw new Error('fromX, fromY, toX, toY are required for action "mouse_drag"');
                        }

                        const result = await bridge.sendCommand('send_mouse_drag', {
                            from_x: fromX,
                            from_y: fromY,
                            to_x: toX,
                            to_y: toY,
                            steps: (params.steps as number) ?? 10,
                            duration_ms: (params.durationMs as number) ?? 200,
                            button: (params.button as number) ?? 1,
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    case 'text': {
                        const text = params.text as string;
                        if (!text) throw new Error('text is required for action "text"');

                        const result = await bridge.sendCommand('send_text', {
                            text,
                            delay_ms: (params.delayMs as number) ?? 50,
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Game input action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
