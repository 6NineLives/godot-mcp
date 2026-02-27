/**
 * Visualizer tools — project-wide structural analysis and mapping.
 *
 * Single consolidated tool: `visualize_project`
 * Actions: map_scripts | map_scenes
 *
 * Uses WebSocket for editor-side crawling and parsing.
 */

import { z } from 'zod';
import { getGodotConnection } from '../../utils/godot_connection.js';
import { serveVisualization } from '../../utils/visualizer_server.js';
import { MCPTool, CommandResult } from '../../utils/types.js';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const visualizerTools: MCPTool[] = [
    {
        name: 'visualize_project',
        description:
            'Analyze and map the project structure for AI understanding. ' +
            'Actions: "map_scripts" to crawl all GDScript files and build a dependency graph ' +
            '(classes, functions, signals, variables, extends/preload relationships), ' +
            '"map_scenes" to crawl all .tscn files and return node hierarchies, scripts, and inter-scene references.',
        parameters: z.object({
            action: z
                .enum(['map_scripts', 'map_scenes'])
                .describe('Which visualization action to perform'),
            root_path: z.string().optional().describe(
                'Root directory to scan from (default: "res://"). Use to limit scan scope.'
            ),
            include_addons: z.boolean().optional().describe(
                'Include the addons directory in scan (default: false).'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;
            const godot = getGodotConnection();

            try {
                switch (action) {
                    case 'map_scripts': {
                        const result = await godot.sendCommand<CommandResult>('map_project_scripts', {
                            root_path: (params.root_path as string) ?? 'res://',
                            include_addons: (params.include_addons as boolean) ?? false,
                        });

                        // Addon wraps data under project_map; unwrap it.
                        const projectMap = (result.project_map ?? result) as {
                            nodes: Array<{
                                path: string;
                                class_name: string;
                                extends: string;
                                functions: Array<{ name: string; params: string }>;
                                signals: Array<{ name: string; params: string }>;
                                variables: Array<{ name: string; type: string }>;
                                preloads: string[];
                                line_count: number;
                            }>;
                            edges: Array<{ from: string; to: string; type: string }>;
                            total_scripts: number;
                        };

                        const scripts = projectMap.nodes ?? [];
                        const edges = projectMap.edges ?? [];
                        const scriptCount = projectMap.total_scripts ?? scripts.length;

                        const url = await serveVisualization(projectMap);

                        let output = `Project Script Map (${scriptCount} scripts, ${edges.length} relationships)\n`;
                        output += `Interactive Graph: ${url}\n\n`;

                        for (const s of scripts) {
                            const className = s.class_name ? ` (class: ${s.class_name})` : '';
                            const ext = s.extends ? ` extends ${s.extends}` : '';
                            output += `📄 ${s.path}${className}${ext} [${s.line_count} lines]\n`;

                            if (s.functions.length > 0) {
                                output += `   Functions: ${s.functions.map(f => f.name).join(', ')}\n`;
                            }
                            if (s.signals.length > 0) {
                                output += `   Signals: ${s.signals.map(sig => sig.name ?? sig).join(', ')}\n`;
                            }
                            if (s.variables.length > 0) {
                                output += `   Variables: ${s.variables.map(v => `${v.name}: ${v.type}`).join(', ')}\n`;
                            }
                            if (s.preloads && s.preloads.length > 0) {
                                output += `   Preloads: ${s.preloads.join(', ')}\n`;
                            }
                            output += '\n';
                        }

                        if (edges.length > 0) {
                            output += 'Relationships:\n';
                            for (const e of edges) {
                                output += `  ${e.from} --[${e.type}]--> ${e.to}\n`;
                            }
                        }

                        return output;
                    }

                    case 'map_scenes': {
                        const result = await godot.sendCommand<CommandResult>('map_project_scenes', {
                            root_path: (params.root_path as string) ?? 'res://',
                            include_addons: (params.include_addons as boolean) ?? false,
                        });

                        // Addon wraps data under scene_map; unwrap it.
                        const sceneMap = (result.scene_map ?? result) as {
                            scenes: Array<{
                                path: string;
                                nodes: Array<{ name: string; type: string; parent?: string }>;
                                instances: string[];
                                scripts: string[];
                                node_count: number;
                            }>;
                            edges: Array<{ from: string; to: string; type: string }>;
                            total_scenes: number;
                        };

                        const scenes = sceneMap.scenes ?? [];
                        const sceneCount = sceneMap.total_scenes ?? scenes.length;

                        const url = await serveVisualization(sceneMap);

                        let output = `Project Scene Map (${sceneCount} scenes)\n`;
                        output += `Interactive Graph: ${url}\n\n`;

                        for (const scene of scenes) {
                            output += `🎬 ${scene.path}\n`;
                            output += `   Nodes: ${scene.node_count ?? scene.nodes.length}\n`;

                            if (scene.scripts && scene.scripts.length > 0) {
                                output += `   Scripts: ${scene.scripts.join(', ')}\n`;
                            }

                            // Show node tree hierarchy
                            if (scene.nodes && scene.nodes.length > 0) {
                                output += '   Tree:\n';
                                for (const node of scene.nodes) {
                                    const indent = node.parent ? '     ' : '   ';
                                    output += `${indent}${node.name} (${node.type})\n`;
                                }
                            }
                            output += '\n';
                        }

                        return output;
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Visualize action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
