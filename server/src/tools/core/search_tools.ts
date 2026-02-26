/**
 * Project file search tools (headless — no WebSocket required).
 *
 * Single consolidated tool: `search_project`
 * Actions: find_files | read_file
 *
 * Bridges the GDAI MCP gap: AI can say "use human001 sprite" and these tools
 * will find it in the project. Also provides file reading for text assets.
 */

import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { MCPTool } from '../../utils/types.js';
import { detectProjectPath, validatePath, isGodotProject } from '../../core/path-manager.js';
import { getCodeIndexer } from '../../utils/indexer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileMatch {
    resPath: string;
    absolutePath: string;
    extension: string;
    sizeBytes: number;
    category: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CATEGORY_MAP: Record<string, string> = {
    '.tscn': 'scene',
    '.scn': 'scene',
    '.gd': 'script',
    '.gdshader': 'shader',
    '.gdshaderinc': 'shader',
    '.tres': 'resource',
    '.res': 'resource',
    '.png': 'image',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.svg': 'image',
    '.webp': 'image',
    '.bmp': 'image',
    '.tga': 'image',
    '.exr': 'image',
    '.hdr': 'image',
    '.ogg': 'audio',
    '.wav': 'audio',
    '.mp3': 'audio',
    '.flac': 'audio',
    '.glb': 'model',
    '.gltf': 'model',
    '.obj': 'model',
    '.fbx': 'model',
    '.dae': 'model',
    '.blend': 'model',
    '.ttf': 'font',
    '.otf': 'font',
    '.woff': 'font',
    '.woff2': 'font',
    '.json': 'data',
    '.cfg': 'data',
    '.ini': 'data',
    '.xml': 'data',
    '.csv': 'data',
    '.txt': 'data',
    '.md': 'data',
    '.import': 'import',
    '.gdignore': 'config',
};

/** Classify file extension into an asset category. */
function categorize(ext: string): string {
    return CATEGORY_MAP[ext.toLowerCase()] ?? 'other';
}

/** Convert an absolute path to a res:// relative path. */
function toResPath(projectPath: string, absolutePath: string): string {
    const rel = path.relative(projectPath, absolutePath).replace(/\\/g, '/');
    return `res://${rel}`;
}

/** Case-insensitive glob-style match (supports * and ?). */
function globMatch(pattern: string, text: string): boolean {
    const regexStr = pattern
        .toLowerCase()
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${regexStr}$`).test(text.toLowerCase());
}

const SKIP_DIRS = new Set(['.godot', '.git', '.import', '__pycache__', 'node_modules']);
const MAX_RESULTS = 200;

/** Recursively search for files matching criteria under a project directory. */
function searchFiles(
    projectPath: string,
    dir: string,
    options: {
        pattern?: string;
        extensions?: string[];
        category?: string;
    },
    results: FileMatch[],
): void {
    if (results.length >= MAX_RESULTS) return;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (results.length >= MAX_RESULTS) return;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                searchFiles(projectPath, fullPath, options, results);
            }
            continue;
        }

        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();

        // Extension filter
        if (options.extensions && options.extensions.length > 0) {
            const normalizedExts = options.extensions.map((e) =>
                e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`,
            );
            if (!normalizedExts.includes(ext)) continue;
        }

        // Category filter
        if (options.category) {
            if (categorize(ext) !== options.category.toLowerCase()) continue;
        }

        // Name/pattern filter
        if (options.pattern) {
            const nameNoExt = path.basename(entry.name, ext);
            const fullName = entry.name;
            const resP = toResPath(projectPath, fullPath);

            const p = options.pattern;
            const matchesGlob =
                globMatch(p, fullName) || globMatch(p, nameNoExt) || globMatch(p, resP);
            const matchesSubstring =
                fullName.toLowerCase().includes(p.toLowerCase()) ||
                resP.toLowerCase().includes(p.toLowerCase());

            if (!matchesGlob && !matchesSubstring) continue;
        }

        let sizeBytes = 0;
        try {
            sizeBytes = fs.statSync(fullPath).size;
        } catch {
            // ignore
        }

        results.push({
            resPath: toResPath(projectPath, fullPath),
            absolutePath: fullPath,
            extension: ext,
            sizeBytes,
            category: categorize(ext),
        });
    }
}

/** Binary extensions that should not be read as text. */
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.bmp', '.webp', '.exr', '.hdr', '.svg',
    '.wav', '.ogg', '.mp3', '.flac',
    '.glb', '.gltf', '.obj', '.fbx', '.dae', '.blend',
    '.ttf', '.otf', '.woff', '.woff2',
    '.res', '.scn',
]);

const MAX_READ_SIZE = 512 * 1024; // 512 KB

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const searchTools: MCPTool[] = [
    {
        name: 'search_project',
        description:
            'Search for files or read file contents in a Godot project. ' +
            'Actions: "find_files" to search by name, extension, or category; ' +
            '"read_file" to read text file contents. ' +
            'Supports glob patterns (e.g. "*player*", "*.gd").',
        parameters: z.object({
            action: z
                .enum(['find_files', 'read_file'])
                .describe('Which search action to perform'),
            projectPath: z.string().optional().describe(
                'Optional absolute path to the Godot project directory. If omitted, it will be auto-detected.',
            ),
            // For find_files
            pattern: z.string().optional().describe(
                'For find_files: filename pattern (glob or substring). E.g. "*player*", "main.tscn"',
            ),
            extensions: z.array(z.string()).optional().describe(
                'For find_files: filter by file extensions. E.g. [".gd", ".tscn"]',
            ),
            category: z.string().optional().describe(
                'For find_files: filter by asset category — scene, script, shader, resource, image, audio, model, font, data',
            ),
            // For read_file
            filePath: z.string().optional().describe(
                'For read_file: path to the file — either absolute or res:// relative (e.g. "res://scripts/player.gd")',
            ),
        }),
        execute: async (params: Record<string, unknown>) => {
            const action = params.action as string;
            const projectPath = params.projectPath as string | undefined;

            const resolvedPath = detectProjectPath(projectPath);
            if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
            if (!isGodotProject(resolvedPath))
                throw new Error(`Not a Godot project: ${resolvedPath}`);

            switch (action) {
                case 'find_files': {
                    const results: FileMatch[] = [];
                    searchFiles(
                        resolvedPath,
                        resolvedPath,
                        {
                            pattern: params.pattern as string | undefined,
                            extensions: params.extensions as string[] | undefined,
                            category: params.category as string | undefined,
                        },
                        results,
                    );

                    if (results.length === 0) {
                        return 'No files found matching your criteria.';
                    }

                    // Group by category for structured output
                    const grouped: Record<string, { count: number; files: { name: string; resPath: string; absolutePath: string; sizeKB: string }[] }> = {};
                    for (const match of results) {
                        if (!grouped[match.category]) {
                            grouped[match.category] = { count: 0, files: [] };
                        }
                        grouped[match.category].count++;
                        grouped[match.category].files.push({
                            name: path.basename(match.resPath),
                            resPath: match.resPath,
                            absolutePath: match.absolutePath,
                            sizeKB: (match.sizeBytes / 1024).toFixed(1),
                        });
                    }

                    const response = {
                        totalFiles: results.length,
                        capped: results.length >= MAX_RESULTS,
                        byCategory: grouped,
                    };

                    return JSON.stringify(response, null, 2);
                }

                case 'read_file': {
                    const filePath = params.filePath as string;
                    if (!filePath) throw new Error('filePath is required for action "read_file"');

                    // Resolve res:// paths
                    let absolutePath: string;
                    if (filePath.startsWith('res://')) {
                        const relative = filePath.slice(6);
                        absolutePath = path.join(resolvedPath, relative);
                    } else if (path.isAbsolute(filePath)) {
                        absolutePath = filePath;
                    } else {
                        absolutePath = path.join(resolvedPath, filePath);
                    }

                    // Normalize and validate
                    absolutePath = path.resolve(absolutePath);
                    const normalizedProject = path.resolve(resolvedPath);
                    if (!absolutePath.startsWith(normalizedProject)) {
                        throw new Error('File path is outside the project directory');
                    }

                    if (!fs.existsSync(absolutePath)) {
                        throw new Error(`File not found: ${absolutePath}`);
                    }

                    const ext = path.extname(absolutePath).toLowerCase();
                    if (BINARY_EXTENSIONS.has(ext)) {
                        throw new Error(
                            `Cannot read binary file (${ext}). ` +
                            `Use this path in other tools that accept file references.`
                        );
                    }

                    const stat = fs.statSync(absolutePath);
                    if (stat.size > MAX_READ_SIZE) {
                        throw new Error(
                            `File too large (${(stat.size / 1024).toFixed(0)} KB). ` +
                            `Maximum readable size is ${MAX_READ_SIZE / 1024} KB.`,
                        );
                    }

                    const content = fs.readFileSync(absolutePath, 'utf-8');
                    const resPath = toResPath(resolvedPath, absolutePath);

                    return JSON.stringify({
                        path: resPath,
                        absolutePath,
                        extension: ext,
                        sizeKB: (stat.size / 1024).toFixed(1),
                        content,
                    }, null, 2);
                }

                default:
                    throw new Error(`Unknown action: ${action}`);
            }
        },
    },
    {
        name: 'semantic_search',
        description:
            'Perform a semantic search across the Godot project codebase to find relevant code snippets, functions, or scenes based on natural language meaning. ' +
            'This uses a local embedding model, so you can search concepts (e.g., "player jumping logic") rather than exact keywords. ' +
            'This is the preferred tool for exploring codebase concepts you are unfamiliar with.',
        parameters: z.object({
            query: z.string().describe('Natural language query to search for (e.g., "Where is enemy health calculated?")'),
            projectPath: z.string().optional().describe('Optional absolute path to the Godot project directory. If omitted, it will be auto-detected.'),
            limit: z.number().optional().default(5).describe('Maximum number of results to return (default: 5)'),
        }),
        execute: async (params: Record<string, unknown>) => {
            const query = params.query as string;
            const projectPath = params.projectPath as string | undefined;
            const limit = params.limit as number;

            const resolvedPath = detectProjectPath(projectPath);
            if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
            if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath}`);

            const indexer = getCodeIndexer(resolvedPath);

            try {
                // Ensure index is built before searching
                await indexer.buildIndex();
                const results = await indexer.search(query, limit);

                if (results.length === 0) {
                    return 'No semantic matches found for your query.';
                }

                return JSON.stringify({
                    query,
                    results: results.map(r => ({
                        path: r.path,
                        distance: r.distance.toFixed(4), // Lower distance is better
                        snippet: r.content
                    }))
                }, null, 2);
            } catch (error: any) {
                throw new Error(`Semantic search failed: ${error.message}`);
            }
        },
    }
];
