/**
 * Discovery tools — scan a Godot project to find reusable assets (headless).
 *
 * Provides structured information about existing scenes, scripts, textures,
 * and audio files so that AI clients can reference and reuse them instead
 * of recreating content from scratch.
 */

import { z } from 'zod';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, extname, relative } from 'path';
import { MCPTool } from '../../utils/types.js';
import { validatePath, isGodotProject, detectProjectPath } from '../../core/path-manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SceneInfo {
    path: string;       // res:// path
    rootType: string;   // e.g. "CharacterBody2D", "Node2D"
    rootName: string;   // e.g. "Player", "Golem"
    externalScenes: string[]; // instanced sub-scenes (res:// paths)
    hasScript: boolean;
}

interface ScriptInfo {
    path: string;       // res:// path
    extends: string;    // e.g. "CharacterBody2D", "Node2D"
    className: string;  // class_name if defined, else ""
}

interface AssetInfo {
    path: string;       // res:// path
    type: string;       // "texture", "audio", "font", "shader", etc.
    extension: string;
}

type AssetCategory = 'scenes' | 'scripts' | 'textures' | 'audio' | 'resources';

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseSceneFile(absolutePath: string, projectRoot: string): SceneInfo | null {
    try {
        const content = readFileSync(absolutePath, 'utf8');
        const lines = content.split('\n');

        const resPath = 'res://' + relative(projectRoot, absolutePath).replace(/\\/g, '/');

        let rootType = 'Node';
        let rootName = '';
        const externalScenes: string[] = [];
        let hasScript = false;

        for (const line of lines) {
            // Find instanced external scenes
            const extSceneMatch = line.match(/\[ext_resource\s+type="PackedScene".*path="([^"]+)"/);
            if (extSceneMatch) {
                externalScenes.push(extSceneMatch[1]);
            }

            // Find the root node (first [node ...] without parent)
            const nodeMatch = line.match(/^\[node\s+name="([^"]+)"\s+type="([^"]+)"/);
            if (nodeMatch && !line.includes('parent=')) {
                rootName = nodeMatch[1];
                rootType = nodeMatch[2];
            }

            // Check for script
            if (line.includes('script = ExtResource(') || line.includes('script = "res://')) {
                hasScript = true;
            }
        }

        return { path: resPath, rootType, rootName, externalScenes, hasScript };
    } catch {
        return null;
    }
}

function parseScriptFile(absolutePath: string, projectRoot: string): ScriptInfo | null {
    try {
        const content = readFileSync(absolutePath, 'utf8');
        const lines = content.split('\n').slice(0, 20); // Only need the header

        const resPath = 'res://' + relative(projectRoot, absolutePath).replace(/\\/g, '/');

        let extendsClass = 'Node';
        let className = '';

        for (const line of lines) {
            const extendsMatch = line.match(/^extends\s+(\S+)/);
            if (extendsMatch) {
                extendsClass = extendsMatch[1];
            }

            const classMatch = line.match(/^class_name\s+(\S+)/);
            if (classMatch) {
                className = classMatch[1];
            }
        }

        return { path: resPath, extends: extendsClass, className };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const TEXTURE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.svg', '.webp', '.bmp', '.tga']);
const AUDIO_EXTS = new Set(['.ogg', '.wav', '.mp3']);
const RESOURCE_EXTS = new Set(['.tres', '.res']);
const IGNORE_DIRS = new Set(['.godot', '.git', '.import', 'addons', '__pycache__']);

function scanDirectory(
    dir: string,
    projectRoot: string,
    categories: Set<AssetCategory>,
    results: {
        scenes: SceneInfo[];
        scripts: ScriptInfo[];
        textures: AssetInfo[];
        audio: AssetInfo[];
        resources: AssetInfo[];
    },
    depth: number = 0,
): void {
    if (depth > 8) return; // prevent runaway recursion

    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }

    for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
            const stat = statSync(fullPath);

            if (stat.isDirectory()) {
                if (!IGNORE_DIRS.has(entry.toLowerCase())) {
                    scanDirectory(fullPath, projectRoot, categories, results, depth + 1);
                }
                continue;
            }

            const ext = extname(entry).toLowerCase();
            const resPath = 'res://' + relative(projectRoot, fullPath).replace(/\\/g, '/');

            if (ext === '.tscn' && categories.has('scenes')) {
                const info = parseSceneFile(fullPath, projectRoot);
                if (info) results.scenes.push(info);
            } else if (ext === '.gd' && categories.has('scripts')) {
                const info = parseScriptFile(fullPath, projectRoot);
                if (info) results.scripts.push(info);
            } else if (TEXTURE_EXTS.has(ext) && categories.has('textures')) {
                results.textures.push({ path: resPath, type: 'texture', extension: ext });
            } else if (AUDIO_EXTS.has(ext) && categories.has('audio')) {
                results.audio.push({ path: resPath, type: 'audio', extension: ext });
            } else if (RESOURCE_EXTS.has(ext) && categories.has('resources')) {
                results.resources.push({ path: resPath, type: 'resource', extension: ext });
            }
        } catch {
            // Skip inaccessible entries
        }
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const discoveryTools: MCPTool[] = [
    {
        name: 'get_project_assets',
        description:
            'Scan a Godot project to discover all reusable assets (scenes, scripts, textures, audio, resources). ' +
            'IMPORTANT: Call this BEFORE creating new scenes or scripts to check what already exists. ' +
            'Returns structured data with scene root types, script extends classes, and asset paths. ' +
            'Use the results to instance existing scenes (ExtResource) instead of recreating them.',
        parameters: z.object({
            projectPath: z.string().optional().describe(
                'Optional absolute path to the Godot project directory. If omitted, it will be auto-detected.'
            ),
            categories: z.array(
                z.enum(['scenes', 'scripts', 'textures', 'audio', 'resources'])
            ).optional().describe(
                'Filter which asset categories to return. Defaults to ["scenes", "scripts"]'
            ),
        }),
        execute: async (params: Record<string, unknown>) => {
            const projectPath = params.projectPath as string | undefined;
            const categories = params.categories as string[] | undefined;

            const resolvedProject = detectProjectPath(projectPath);
            if (!validatePath(resolvedProject)) throw new Error('Invalid project path');
            if (!isGodotProject(resolvedProject)) {
                throw new Error(
                    `Not a Godot project: ${resolvedProject}. ` +
                    'Tools may fail if this is not a valid project.'
                );
            }

            const selectedCategories = new Set<AssetCategory>(
                (categories as AssetCategory[] | undefined) ?? ['scenes', 'scripts']
            );

            const results = {
                scenes: [] as SceneInfo[],
                scripts: [] as ScriptInfo[],
                textures: [] as AssetInfo[],
                audio: [] as AssetInfo[],
                resources: [] as AssetInfo[],
            };

            scanDirectory(resolvedProject, resolvedProject, selectedCategories, results);

            // Build a useful summary
            const summary: string[] = [];
            if (results.scenes.length > 0) {
                summary.push(`📦 ${results.scenes.length} scene(s) — these can be instanced as child nodes`);
            }
            if (results.scripts.length > 0) {
                summary.push(`📜 ${results.scripts.length} script(s)`);
            }
            if (results.textures.length > 0) {
                summary.push(`🖼️ ${results.textures.length} texture(s)`);
            }
            if (results.audio.length > 0) {
                summary.push(`🔊 ${results.audio.length} audio file(s)`);
            }
            if (results.resources.length > 0) {
                summary.push(`📄 ${results.resources.length} resource(s)`);
            }

            // Only include non-empty categories in output
            const output: Record<string, unknown> = {
                projectPath: resolvedProject,
                summary: summary.join('\n'),
            };

            for (const [key, value] of Object.entries(results)) {
                if ((value as unknown[]).length > 0) {
                    output[key] = value;
                }
            }

            return JSON.stringify(output, null, 2);
        },
    },
];
