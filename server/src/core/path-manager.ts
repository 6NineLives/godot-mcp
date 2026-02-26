/**
 * Godot executable path detection, validation, and caching.
 *
 * Supports three resolution strategies (in priority order):
 *   1. Explicit GODOT_PATH environment variable or config value
 *   2. Platform-specific auto-detection (common install locations)
 *   3. 'godot' on the system PATH
 *
 * Once a path is validated via `godot --version`, the result is cached
 * so subsequent calls are instant.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, normalize, resolve } from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { logDebug, logWarn, logError } from '../utils/logger.js';
import { loadConfig } from '../config/config.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Client workspace roots (sent by IDE during MCP initialization)
// ---------------------------------------------------------------------------

/** Workspace root URIs received from the MCP client (IDE). */
let _clientRoots: string[] = [];

/**
 * Store workspace roots sent by the IDE during MCP initialization.
 * Called from index.ts on `server.on('connect')`.
 * Roots are file:// URIs — we strip the scheme and normalize them.
 */
export function setClientRoots(roots: Array<{ uri: string }>): void {
    _clientRoots = roots
        .map(r => r.uri)
        .filter(Boolean)
        .map(uri => {
            // Strip file:// and normalize
            const stripped = uri.startsWith('file:///')
                ? (process.platform === 'win32'
                    ? uri.slice(8).replace(/\//g, '\\')
                    : uri.slice(7))
                : uri;
            return resolve(decodeURIComponent(stripped));
        })
        .filter(p => p.length > 0);
    logDebug(`setClientRoots: ${_clientRoots.length} roots → ${_clientRoots.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Validation cache
// ---------------------------------------------------------------------------

const validatedPaths = new Map<string, boolean>();

/** Cached result from a previous successful `detectGodotPath` call. */
let cachedGodotPath: string | null = null;

// ---------------------------------------------------------------------------
// Low-level validators
// ---------------------------------------------------------------------------

/**
 * Validate a path to prevent traversal and access to system directories.
 * Blocks: empty paths, '..', null bytes, UNC paths, and known system dirs.
 */
export function validatePath(inputPath: string): boolean {
    if (!inputPath || typeof inputPath !== 'string') return false;

    // Block null bytes (can bypass OS-level checks)
    if (inputPath.includes('\0')) return false;

    // Block path traversal
    if (inputPath.includes('..')) return false;

    // Block UNC paths (\\server\share)
    if (inputPath.startsWith('\\\\')) return false;

    // Block access to well-known system directories
    const normalized = inputPath.replace(/\\/g, '/').toLowerCase();
    const systemDirs = [
        '/etc', '/usr', '/var', '/bin', '/sbin', '/boot', '/proc', '/sys',
        '/dev', '/tmp', '/root',
        'c:/windows', 'c:/program files', 'c:/programdata',
        'c:/users/public',
    ];
    for (const dir of systemDirs) {
        if (normalized === dir || normalized.startsWith(dir + '/')) return false;
    }

    return true;
}

/** Check whether a directory contains a `project.godot` file. */
export function isGodotProject(dirPath: string): boolean {
    try {
        return existsSync(join(dirPath, 'project.godot'));
    } catch {
        return false;
    }
}

/** Normalise a file-system path (resolve back-slashes, etc.). */
export function normalizePath(p: string): string {
    return normalize(p);
}

// ---------------------------------------------------------------------------
// Godot executable validation
// ---------------------------------------------------------------------------

/** Quick synchronous existence check (no version probe). */
export function isValidGodotPathSync(path: string): boolean {
    try {
        return path === 'godot' || existsSync(path);
    } catch {
        return false;
    }
}

/**
 * Full async validation: checks file existence then runs `godot --version`.
 * Results are cached for the lifetime of the process.
 */
export async function isValidGodotPath(path: string): Promise<boolean> {
    if (validatedPaths.has(path)) return validatedPaths.get(path)!;

    try {
        logDebug(`Validating Godot path: ${path}`);

        if (path !== 'godot' && !existsSync(path)) {
            logDebug(`Path does not exist: ${path}`);
            validatedPaths.set(path, false);
            return false;
        }

        // Probe with --version (uses execFile to avoid command injection)
        const { stdout } = await execFileAsync(path, ['--version']);
        logDebug(`Valid Godot path: ${path} (version ${stdout.trim()})`);
        validatedPaths.set(path, true);
        return true;
    } catch (error) {
        logDebug(`Invalid Godot path: ${path}`);
        validatedPaths.set(path, false);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

/**
 * Detect the Godot executable by checking, in order:
 *   1. An explicit `pathHint` argument (from config / env)
 *   2. The GODOT_PATH environment variable
 *   3. Platform-specific common install locations
 *
 * Returns `null` when no valid Godot exec can be found.
 */
export async function detectGodotPath(pathHint?: string): Promise<string | null> {
    // Return cached result from a previous successful detection
    if (cachedGodotPath) return cachedGodotPath;

    // 1. Explicit hint (e.g. from godot-mcp.config.json)
    if (pathHint) {
        const norm = normalize(pathHint);
        if (await isValidGodotPath(norm)) {
            logDebug(`Using provided Godot path: ${norm}`);
            cachedGodotPath = norm;
            return cachedGodotPath;
        }
    }

    // 2. GODOT_PATH env var
    if (process.env.GODOT_PATH) {
        const envPath = normalize(process.env.GODOT_PATH);
        if (await isValidGodotPath(envPath)) {
            logDebug(`Using GODOT_PATH env: ${envPath}`);
            cachedGodotPath = envPath;
            return cachedGodotPath;
        }
        logWarn('GODOT_PATH was set but is not a valid Godot executable');
    }

    // 3. Platform auto-detect
    const candidates: string[] = ['godot'];

    const platform = process.platform;
    if (platform === 'darwin') {
        candidates.push(
            '/Applications/Godot.app/Contents/MacOS/Godot',
            '/Applications/Godot_4.app/Contents/MacOS/Godot',
            `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
            `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
            `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`,
        );
    } else if (platform === 'win32') {
        const userProfile = process.env.USERPROFILE ?? '';
        const localAppData = process.env.LOCALAPPDATA ?? '';
        candidates.push(
            // Standard install locations
            'C:\\Program Files\\Godot\\Godot.exe',
            'C:\\Program Files (x86)\\Godot\\Godot.exe',
            'C:\\Program Files\\Godot_4\\Godot.exe',
            'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
            // User-level locations
            `${userProfile}\\Godot\\Godot.exe`,
            `${localAppData}\\Godot\\Godot.exe`,
            // Steam
            'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine\\godot.windows.editor.x86_64.exe',
            // Scoop
            `${userProfile}\\scoop\\apps\\godot\\current\\godot.exe`,
            `${userProfile}\\scoop\\apps\\godot-mono\\current\\godot.exe`,
        );

        // Portable downloads: scan Downloads and Desktop for Godot_v*.exe
        // Handles both flat exes and nested directories (e.g. Godot_v4.4.1-stable_win64.exe/Godot_v4.4.1-stable_win64.exe)
        const downloadsDir = `${userProfile}\\Downloads`;
        const desktopDir = `${userProfile}\\Desktop`;
        for (const searchDir of [downloadsDir, desktopDir]) {
            try {
                if (existsSync(searchDir)) {
                    for (const entry of readdirSync(searchDir)) {
                        const entryPath = join(searchDir, entry);
                        if (entry.match(/^Godot_v[\d.]+.*\.exe$/i)) {
                            // Direct exe file
                            candidates.push(entryPath);
                        } else if (entry.match(/^Godot_v[\d.]+/i)) {
                            // Directory named like a Godot release — scan inside
                            try {
                                for (const inner of readdirSync(entryPath)) {
                                    if (inner.match(/^Godot_v[\d.]+.*\.exe$/i)) {
                                        candidates.push(join(entryPath, inner));
                                    }
                                }
                            } catch { /* not a directory or not accessible */ }
                        }
                    }
                }
            } catch {
                // Ignore errors scanning directory
            }
        }
    } else if (platform === 'linux') {
        candidates.push(
            '/usr/bin/godot',
            '/usr/local/bin/godot',
            '/snap/bin/godot',
            `${process.env.HOME}/.local/bin/godot`,
        );
    }

    for (const candidate of candidates) {
        const norm = normalize(candidate);
        if (await isValidGodotPath(norm)) {
            logDebug(`Auto-detected Godot at: ${norm}`);
            cachedGodotPath = norm;
            return cachedGodotPath;
        }
    }

    logWarn(`Could not find Godot in common locations for ${platform}`);
    logWarn('Set GODOT_PATH environment variable or "godotPath" in godot-mcp.config.json.');
    return null;
}

/** Get the cached Godot path from a previous successful detection, or null. */
export function getCachedGodotPath(): string | null {
    return cachedGodotPath;
}


/**
 * Walk up the directory tree from `startDir` looking for a `project.godot` file.
 * Returns the directory containing it, or `null` if not found.
 */
function findProjectRoot(startDir: string): string | null {
    let dir = resolve(startDir);
    const root = resolve(dir, '/'); // filesystem root

    while (true) {
        if (isGodotProject(dir)) {
            return dir;
        }
        const parent = resolve(dir, '..');
        if (parent === dir || dir === root) break; // reached filesystem root
        dir = parent;
    }
    return null;
}

/**
 * Get the directory where the MCP server's own code lives.
 * Works whether running from `dist/` (compiled) or `src/` (dev).
 */
function getServerDir(): string {
    // import.meta.url → file:///C:/path/to/server/dist/core/path-manager.js
    // We want the server root (parent of dist/)
    try {
        const thisFile = new URL(import.meta.url).pathname;
        // On Windows, URL pathname starts with /C:/ — strip the leading /
        const normalized = process.platform === 'win32'
            ? thisFile.replace(/^\/([A-Za-z]:)/, '$1')
            : thisFile;
        // Go up from dist/core/ → dist/ → server/
        return resolve(normalized, '..', '..', '..');
    } catch {
        return resolve(__dirname, '..', '..');
    }
}

/**
 * Check if the given project root is actually the MCP addon's own
 * development/test project — not the user's actual game.
 *
 * We detect this by looking for telltale signs:
 *  - A `server/` subdirectory with a `package.json` containing "godot-mcp"
 *  - A project.godot with the name "Godot MCP"
 *  - The addons/godot_mcp directory
 */
function isMcpAddonProject(projectRoot: string): boolean {
    try {
        // Check 1: Does this project root contain the server/ directory
        // with a package.json that has "godot-mcp" in the name?
        const serverPkg = join(projectRoot, 'server', 'package.json');
        if (existsSync(serverPkg)) {
            const pkg = readFileSync(serverPkg, 'utf8');
            if (pkg.includes('godot-mcp')) {
                return true;
            }
        }

        // Check 2: Does the project.godot name itself say "Godot MCP"?
        const projectFile = join(projectRoot, 'project.godot');
        if (existsSync(projectFile)) {
            const content = readFileSync(projectFile, 'utf8');
            if (content.includes('config/name="Godot MCP"')) {
                return true;
            }
        }
    } catch {
        // Safe to ignore read errors
    }
    return false;
}

/**
 * Check if the given directory path appears to be an IDE or system installation 
 * directory (like Kiro, VS Code, Cursor, etc.). This prevents the MCP server
 * from accidentally treating the IDE's internal folder as the user's project.
 */
function isIdeInstallDir(dirPath: string): boolean {
    const normalized = dirPath.replace(/\\/g, '/').toLowerCase();

    // Common IDE/App directories on Windows
    if (normalized.includes('/appdata/local/programs/')) return true;
    if (normalized.includes('/appdata/roaming/')) return true;
    if (normalized.includes('/program files/')) return true;
    if (normalized.includes('/program files (x86)/')) return true;

    // Common directories on macOS
    if (normalized.includes('/applications/') || normalized.startsWith('/applications/')) {
        // Exclude the user's own projects folder if they bizarrely named it 'applications'
        // Just checking if it's within an .app bundle or top-level Applications.
        if (normalized.includes('.app/')) return true;
    }

    // Known IDEs by name
    const ideNames = ['kiro', 'cursor', 'code', 'webstorm', 'intellij'];
    const dirname = normalized.split('/').pop() || '';
    if (ideNames.some(name => dirname === name || dirname.startsWith(name + ' '))) {
        return true;
    }

    return false;
}

/**
 * Detect the Godot project root using multiple strategies.
 *
 * Priority order (highest first):
 *   1. Explicit non-trivial `inputPath` argument
 *   1b. `godotProjectPath` from `godot-mcp.config.json`
 *   2. `GODOT_PROJECT_PATH` env var (explicit opt-in override)
 *   3. Client workspace roots (from IDE)
 *   4. Current Working Directory (IDE opens here — most reliable signal)
 *   5. Shallow scan of CWD subdirectories (e.g. `game/project.godot`)
 *   6. Walk up from CWD (deep workspace)
 *   7. Walk up from MCP server directory
 *   8. Fall back to CWD with a warning
 *
 * Note: `GODOT_PROJECT_PATH` is intentionally ranked AFTER CWD so that
 * opening a different project in the IDE automatically takes precedence.
 */
export function detectProjectPath(inputPath?: string): string {
    // 1. Explicit valid input path (not '.' or './')
    if (inputPath && inputPath !== '.' && inputPath !== './') {
        return resolve(inputPath);
    }

    // 1b. godotProjectPath from godot-mcp.config.json — optional explicit override.
    //     Only used when set intentionally by the user; skipped otherwise.
    try {
        const cfg = loadConfig();
        if (cfg.godotProjectPath) {
            const pinned = resolve(cfg.godotProjectPath);
            if (isGodotProject(pinned)) {
                logDebug(`detectProjectPath: using godotProjectPath from config → ${pinned}`);
                return pinned;
            }
            logWarn(`detectProjectPath: godotProjectPath from config is not a Godot project: ${pinned}`);
        }
    } catch {
        // Config load failure is non-fatal; continue with other strategies
    }

    // 2. GODOT_PROJECT_PATH env var — set explicitly in the MCP client config.
    //    Promoted above workspace-root guessing: if the user pinned a path,
    //    that intent should take priority over what folder happens to be open.
    const envProject = process.env.GODOT_PROJECT_PATH;
    if (envProject) {
        const envResolved = resolve(envProject);
        if (isGodotProject(envResolved)) {
            logDebug(`detectProjectPath: using GODOT_PROJECT_PATH env var → ${envResolved}`);
            return envResolved;
        }
        logWarn(`detectProjectPath: GODOT_PROJECT_PATH env var is not a Godot project: ${envResolved}`);
    }

    // 3. Client workspace roots sent by the IDE during MCP initialization.
    //    Skip any root that is the MCP addon's own dev project — opening
    //    godot-mcp-main in your IDE should never be mistaken for the game.
    for (const root of _clientRoots) {
        if (isGodotProject(root) && !isMcpAddonProject(root)) {
            logDebug(`detectProjectPath: found Godot project in client root → ${root}`);
            return root;
        }
        // Also scan immediate subdirectories of each root
        try {
            const entries = readdirSync(root, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    const sub = join(root, entry.name);
                    if (isGodotProject(sub) && !isMcpAddonProject(sub)) {
                        logDebug(`detectProjectPath: found Godot project in client root subdirectory → ${sub}`);
                        return sub;
                    }
                }
            }
        } catch {
            // Ignore read errors for this root
        }
    }

    // 4. Current Working Directory — valid when opening a terminal inside the project.
    //    Skip if CWD looks like an IDE or application installation directory.
    const cwd = process.cwd();
    if (!isIdeInstallDir(cwd)) {
        if (isGodotProject(cwd)) {
            logDebug(`detectProjectPath: CWD is a Godot project → ${cwd}`);
            return cwd;
        }

        // 4a. Shallow scan of CWD subdirectories (e.g. `game/project.godot`)
        try {
            const entries = readdirSync(cwd, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    const subPath = join(cwd, entry.name);
                    if (isGodotProject(subPath)) {
                        logDebug(`detectProjectPath: found project.godot in subdirectory → ${subPath}`);
                        return subPath;
                    }
                }
            }
        } catch {
            // Ignore read errors
        }

        // 4b. Walk up from CWD (if we are deep inside the project)
        const fromCwd = findProjectRoot(cwd);
        if (fromCwd && !isMcpAddonProject(fromCwd)) {
            logDebug(`detectProjectPath: found project.godot walking up from CWD → ${fromCwd}`);
            return fromCwd;
        }
    } else {
        logDebug(`detectProjectPath: skipping CWD — looks like an IDE install dir: ${cwd}`);
    }

    // 5. Walk up from Server Directory (last-resort heuristic)
    const serverDir = getServerDir();
    const fromServer = findProjectRoot(serverDir);
    if (fromServer && !isMcpAddonProject(fromServer)) {
        logDebug(`detectProjectPath: found project.godot walking up from server dir → ${fromServer}`);
        return fromServer;
    }

    // Final fallback: return CWD and let the calling tool report a clear error.
    logWarn(
        `detectProjectPath: could not find project.godot anywhere. ` +
        `CWD="${cwd}". ` +
        `Tip: set GODOT_PROJECT_PATH in your MCP client config, ` +
        `or open your game project folder in your IDE.`
    );
    return resolve(cwd);
}

/** Clear the validated-paths cache (useful in tests or after config change). */
export function clearPathCache(): void {
    validatedPaths.clear();
    cachedGodotPath = null;
}

