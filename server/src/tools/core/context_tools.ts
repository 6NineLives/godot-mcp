/**
 * Context tools — extract structural information from existing scenes (headless).
 *
 * Gives the AI "eyes" by reading a reference level scene and returning
 * structured data about its TileMaps, instanced scenes, node hierarchy,
 * lighting, and UI — so the AI can replicate the pattern when creating
 * new levels.
 */

import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { MCPTool } from '../../utils/types.js';
import { validatePath, isGodotProject, detectProjectPath } from '../../core/path-manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TileMapInfo {
    nodeName: string;
    tileSetSource: string; // res:// path or "embedded"
    layers: string[];
    tileDataSample: string; // first N entries for pattern reference
    format: string;
}

interface InstancedSceneInfo {
    nodeName: string;
    scenePath: string;  // res:// path
    parentPath: string;
    position?: string;
}

interface LightInfo {
    nodeName: string;
    type: string;
    color?: string;
    energy?: string;
    position?: string;
}

interface NodeEntry {
    name: string;
    type: string;
    parent: string;
    depth: number;
}

interface SceneContext {
    sceneFile: string;
    rootNode: { name: string; type: string };
    nodeHierarchy: string;
    tileMapLayers: TileMapInfo[];
    instancedScenes: InstancedSceneInfo[];
    lightingSetup: LightInfo[];
    uiElements: string[];
    scriptPath?: string;
    designNotes: string;
}

// ---------------------------------------------------------------------------
// Scene parser
// ---------------------------------------------------------------------------

function parseSceneContext(content: string, resPath: string): SceneContext {
    const lines = content.split('\n');

    // External resources: id → path
    const extResources = new Map<string, { type: string; path: string }>();
    // Sub resources: id → type
    const subResources = new Map<string, string>();

    let rootNode = { name: 'Unknown', type: 'Node2D' };
    const nodes: NodeEntry[] = [];
    const tileMapLayers: TileMapInfo[] = [];
    const instancedScenes: InstancedSceneInfo[] = [];
    const lightingSetup: LightInfo[] = [];
    const uiElements: string[] = [];
    let scriptPath: string | undefined;

    // Current node being parsed
    let currentNode: {
        name: string;
        type: string;
        parent: string;
        instance?: string;
        properties: Map<string, string>;
    } | null = null;

    for (const line of lines) {
        const trimmed = line.trim();

        // Parse ext_resource
        const extMatch = trimmed.match(
            /\[ext_resource\s+type="([^"]+)".*path="([^"]+)".*id="([^"]+)"/
        );
        if (extMatch) {
            extResources.set(extMatch[3], { type: extMatch[1], path: extMatch[2] });
            continue;
        }

        // Parse sub_resource
        const subMatch = trimmed.match(
            /\[sub_resource\s+type="([^"]+)".*id="([^"]+)"/
        );
        if (subMatch) {
            subResources.set(subMatch[2], subMatch[1]);
            continue;
        }

        // Parse node
        const nodeMatch = trimmed.match(/^\[node\s+(.+)\]$/);
        if (nodeMatch) {
            // Flush previous node
            if (currentNode) {
                flushNode(currentNode);
            }

            const attrs = nodeMatch[1];
            const nameMatch = attrs.match(/name="([^"]+)"/);
            const typeMatch = attrs.match(/type="([^"]+)"/);
            const parentMatch = attrs.match(/parent="([^"]+)"/);
            const instanceMatch = attrs.match(/instance=ExtResource\("([^"]+)"\)/);

            const name = nameMatch?.[1] ?? 'Unknown';
            const type = typeMatch?.[1] ?? (instanceMatch ? 'instance' : 'Node');
            const parent = parentMatch?.[1] ?? '';

            currentNode = {
                name,
                type,
                parent,
                instance: instanceMatch?.[1],
                properties: new Map(),
            };

            // Root node (no parent)
            if (!parent && !parentMatch) {
                rootNode = { name, type };
            }

            continue;
        }

        // Parse property lines (key = value)
        if (currentNode && trimmed.includes(' = ') && !trimmed.startsWith('[')) {
            const eqIdx = trimmed.indexOf(' = ');
            const key = trimmed.substring(0, eqIdx);
            const value = trimmed.substring(eqIdx + 3);
            currentNode.properties.set(key, value);
        }
    }

    // Flush last node
    if (currentNode) {
        flushNode(currentNode);
    }

    function flushNode(node: typeof currentNode) {
        if (!node) return;

        // Calculate depth from parent
        const depth = node.parent === '' ? 0
            : node.parent === '.' ? 1
                : node.parent.split('/').length + 1;

        nodes.push({
            name: node.name,
            type: node.type,
            parent: node.parent,
            depth,
        });

        // Instanced scenes
        if (node.instance) {
            const extRes = extResources.get(node.instance);
            if (extRes) {
                instancedScenes.push({
                    nodeName: node.name,
                    scenePath: extRes.path,
                    parentPath: node.parent,
                    position: node.properties.get('position'),
                });
            }
        }

        // TileMap / TileMapLayer
        if (node.type === 'TileMap' || node.type === 'TileMapLayer') {
            const tileSetProp = node.properties.get('tile_set');
            let tileSetSource = 'embedded';

            if (tileSetProp) {
                const extRefMatch = tileSetProp.match(/ExtResource\("([^"]+)"\)/);
                if (extRefMatch) {
                    const extRes = extResources.get(extRefMatch[1]);
                    tileSetSource = extRes?.path ?? 'unknown';
                } else {
                    const subRefMatch = tileSetProp.match(/SubResource\("([^"]+)"\)/);
                    if (subRefMatch) {
                        tileSetSource = `embedded (${subResources.get(subRefMatch[1]) ?? 'TileSet'})`;
                    }
                }
            }

            // Collect layer names
            const layers: string[] = [];
            for (const [key, value] of node.properties) {
                const layerNameMatch = key.match(/^layer_(\d+)\/name$/);
                if (layerNameMatch) {
                    layers.push(value.replace(/"/g, ''));
                }
            }

            // Get tile_data sample
            let tileDataSample = '';
            for (const [key, value] of node.properties) {
                if (key.includes('tile_data')) {
                    // Get first 30 entries (90 numbers)
                    const match = value.match(/PackedInt32Array\(([^)]+)\)/);
                    if (match) {
                        const nums = match[1].split(',').map(s => s.trim());
                        const sampleNums = nums.slice(0, 90);
                        tileDataSample = `PackedInt32Array(${sampleNums.join(', ')}${nums.length > 90 ? ', ...' : ''})`;
                    }
                    break;
                }
            }

            tileMapLayers.push({
                nodeName: node.name,
                tileSetSource,
                layers: layers.length > 0 ? layers : ['default'],
                tileDataSample,
                format: node.properties.get('format') ?? '2',
            });
        }

        // Lights
        if (node.type.includes('Light2D') || node.type.includes('Light3D')) {
            lightingSetup.push({
                nodeName: node.name,
                type: node.type,
                color: node.properties.get('color'),
                energy: node.properties.get('energy'),
                position: node.properties.get('position'),
            });
        }

        // UI elements (under CanvasLayer or Control)
        if (node.parent.includes('UI') || node.parent.includes('Canvas') ||
            node.type === 'CanvasLayer' || node.type.includes('Container') ||
            node.type === 'Label' || node.type === 'ProgressBar' ||
            node.type === 'Button' || node.type === 'TextureRect') {
            if (depth >= 2) {
                uiElements.push(`${node.parent}/${node.name} (${node.type})`);
            }
        }

        // Script
        if (depth === 0) {
            const scriptProp = node.properties.get('script');
            if (scriptProp) {
                const extRefMatch = scriptProp.match(/ExtResource\("([^"]+)"\)/);
                if (extRefMatch) {
                    const extRes = extResources.get(extRefMatch[1]);
                    scriptPath = extRes?.path;
                }
            }
        }
    }

    // Build hierarchy string
    const hierarchyLines: string[] = [];
    for (const node of nodes) {
        const indent = '  '.repeat(node.depth);
        const isInstance = instancedScenes.some(s => s.nodeName === node.name);
        const label = isInstance
            ? `${node.name} [instanced scene]`
            : `${node.name} (${node.type})`;
        hierarchyLines.push(`${indent}${label}`);
    }

    // Generate design notes
    const notes: string[] = [];
    if (tileMapLayers.length > 0) {
        notes.push(`Level uses ${tileMapLayers.length} TileMap layer(s) for environment.`);
        for (const tm of tileMapLayers) {
            notes.push(`  - "${tm.nodeName}" uses tileset: ${tm.tileSetSource}`);
        }
    } else {
        notes.push('⚠️ No TileMap found — this level may lack proper floor/wall tiles.');
    }
    if (instancedScenes.length > 0) {
        notes.push(`Instances ${instancedScenes.length} external scene(s).`);
    }
    if (lightingSetup.length > 0) {
        notes.push(`Has ${lightingSetup.length} light source(s).`);
    }

    return {
        sceneFile: resPath,
        rootNode,
        nodeHierarchy: hierarchyLines.join('\n'),
        tileMapLayers,
        instancedScenes,
        lightingSetup,
        uiElements,
        scriptPath,
        designNotes: notes.join('\n'),
    };
}

// ---------------------------------------------------------------------------
// Resolve res:// path to absolute path
// ---------------------------------------------------------------------------

function resolveResPath(projectRoot: string, resPath: string): string {
    if (resPath.startsWith('res://')) {
        return join(projectRoot, resPath.substring(6).replace(/\//g, '/'));
    }
    return join(projectRoot, resPath);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const contextTools: MCPTool[] = [
    {
        name: 'get_project_context',
        description:
            'Read an existing level/scene file and extract its structural blueprint: ' +
            'TileMap setup, instanced scenes, node hierarchy, lighting, and UI layout. ' +
            'IMPORTANT: Call this BEFORE creating a new level to understand the project\'s ' +
            'design patterns. Use the results to replicate the same tileset, scene instances, ' +
            'and node hierarchy in your new level.',
        parameters: z.object({
            projectPath: z.string().describe(
                'Path to the Godot project directory, or "." to auto-detect'
            ),
            scenePath: z.string().describe(
                'The res:// path to the scene file to analyze, e.g. "res://scenes/dungeon_level.tscn"'
            ),
        }),
        execute: async ({ projectPath, scenePath }) => {
            const resolvedProject = detectProjectPath(projectPath);
            if (!validatePath(resolvedProject)) throw new Error('Invalid project path');
            if (!isGodotProject(resolvedProject)) {
                throw new Error(
                    `Not a Godot project: ${resolvedProject} (resolved from ${projectPath}). ` +
                    'Set GODOT_PROJECT_PATH env var or pass an absolute project path.'
                );
            }

            const absoluteScene = resolveResPath(resolvedProject, scenePath);
            if (!existsSync(absoluteScene)) {
                throw new Error(`Scene file not found: ${scenePath} (looked at ${absoluteScene})`);
            }

            const content = readFileSync(absoluteScene, 'utf8');
            const context = parseSceneContext(content, scenePath);

            return JSON.stringify(context, null, 2);
        },
    },
];
