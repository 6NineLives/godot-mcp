/**
 * Centralized configuration management for Godot MCP Server.
 * Handles environment variables, file-based config, and runtime defaults.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, normalize } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerConfig {
  /** Explicit path to the Godot executable. */
  godotPath?: string;
  /** Explicit path to the user's Godot game project. When set, overrides all auto-detection. */
  godotProjectPath?: string;
  /** Enable verbose debug logging (stderr). */
  debugMode: boolean;
  /** Pass --debug-godot to headless operations. */
  godotDebugMode: boolean;
  /** When true, throw if Godot cannot be auto-detected instead of warning. */
  strictPathValidation: boolean;
  /** When true, only register read-only tools (no scene/asset mutations). */
  readOnlyMode: boolean;
  /** WebSocket URL for the live-editor Godot addon. */
  websocketUrl: string;
  /** WebSocket port number. */
  websocketPort: number;
  /** Timeout (ms) for WebSocket commands and headless operations. */
  commandTimeout: number;
  /** WebSocket URL for the game bridge autoload. */
  gameBridgeUrl: string;
  /** WebSocket port for the game bridge autoload. */
  gameBridgePort: number;
  /** Allow dangerous game commands (evaluate_expression, call_method). */
  allowUnsafeGameCommands: boolean;
}

export interface ParameterMappings {
  [snakeCase: string]: string;
}

// ---------------------------------------------------------------------------
// Environment-derived constants
// ---------------------------------------------------------------------------

export const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
export const GODOT_DEBUG_MODE: boolean = true; // Always enable for better diagnostics
export const READ_ONLY_MODE: boolean = process.env.READ_ONLY_MODE === 'true';

// ---------------------------------------------------------------------------
// Parameter name mappings (snake_case ↔ camelCase)
// ---------------------------------------------------------------------------

export const PARAMETER_MAPPINGS: ParameterMappings = {
  project_path: 'projectPath',
  scene_path: 'scenePath',
  root_node_type: 'rootNodeType',
  parent_node_path: 'parentNodePath',
  node_type: 'nodeType',
  node_name: 'nodeName',
  texture_path: 'texturePath',
  node_path: 'nodePath',
  output_path: 'outputPath',
  mesh_item_names: 'meshItemNames',
  new_path: 'newPath',
  file_path: 'filePath',
  directory: 'directory',
  recursive: 'recursive',
  scene: 'scene',
};

/** Reverse mapping from camelCase → snake_case (auto-generated). */
export const REVERSE_PARAMETER_MAPPINGS: ParameterMappings = (() => {
  const reverse: ParameterMappings = {};
  for (const [snake, camel] of Object.entries(PARAMETER_MAPPINGS)) {
    reverse[camel] = snake;
  }
  return reverse;
})();

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/** Returns a config populated with defaults and environment overrides. */
export function getDefaultConfig(): ServerConfig {
  return {
    godotPath: process.env.GODOT_PATH,
    godotProjectPath: process.env.GODOT_PROJECT_PATH,
    debugMode: DEBUG_MODE,
    godotDebugMode: GODOT_DEBUG_MODE,
    strictPathValidation: false,
    readOnlyMode: READ_ONLY_MODE,
    websocketUrl: process.env.GODOT_WS_URL ?? 'ws://localhost:9080',
    websocketPort: parseInt(process.env.GODOT_WS_PORT ?? '9080', 10),
    commandTimeout: parseInt(process.env.GODOT_CMD_TIMEOUT ?? '20000', 10),
    gameBridgeUrl: process.env.GODOT_GAME_BRIDGE_URL ?? 'ws://localhost:9081',
    gameBridgePort: parseInt(process.env.GODOT_GAME_BRIDGE_PORT ?? '9081', 10),
    allowUnsafeGameCommands: process.env.ALLOW_UNSAFE_GAME_COMMANDS === 'true',
  };
}

/**
 * Attempt to load a `godot-mcp.config.json` file by searching multiple
 * locations and merge it with the provided config overrides.
 *
 * Search order:
 *   1. process.cwd()
 *   2. MCP server root (parent of dist/)
 *   3. GODOT_PROJECT_PATH env var
 *   4. User home directory
 */
export function loadConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  const base = getDefaultConfig();

  const CONFIG_FILENAME = 'godot-mcp.config.json';

  // Build list of candidate directories to search
  const searchDirs: string[] = [
    process.cwd(),
  ];

  // Server root: resolve from this file's location (dist/config/ → dist/ → server/)
  try {
    const thisFile = new URL(import.meta.url).pathname;
    const normalized = process.platform === 'win32'
      ? thisFile.replace(/^\/([A-Za-z]:)/, '$1')
      : thisFile;
    // From dist/config/config.js → go up to dist/ → up to server/ → up to project root
    const serverRoot = resolve(normalized, '..', '..', '..');
    searchDirs.push(serverRoot);
    // Also check one level above server/ (the overall project root)
    searchDirs.push(resolve(serverRoot, '..'));
  } catch {
    // Fallback for environments without import.meta.url
    try {
      searchDirs.push(resolve(__dirname, '..', '..'));
      searchDirs.push(resolve(__dirname, '..', '..', '..'));
    } catch {
      // Ignore
    }
  }

  // GODOT_PROJECT_PATH
  if (process.env.GODOT_PROJECT_PATH) {
    searchDirs.push(resolve(process.env.GODOT_PROJECT_PATH));
  }

  // User home
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    searchDirs.push(resolve(home));
  }

  // Try each candidate
  for (const dir of searchDirs) {
    try {
      const configPath = resolve(dir, CONFIG_FILENAME);
      if (existsSync(configPath)) {
        const fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
        if (fileConfig.godotPath) base.godotPath = normalize(fileConfig.godotPath);
        // godotProjectPath: explicit pin to your game project — highest priority, overrides IDE CWD.
        // Needed for IDEs (like Kiro) that set process.cwd() to their own install dir.
        if (fileConfig.godotProjectPath) base.godotProjectPath = normalize(fileConfig.godotProjectPath);
        if (fileConfig.debugMode !== undefined) base.debugMode = fileConfig.debugMode;
        if (fileConfig.godotDebugMode !== undefined) base.godotDebugMode = fileConfig.godotDebugMode;
        if (fileConfig.strictPathValidation !== undefined) base.strictPathValidation = fileConfig.strictPathValidation;
        if (fileConfig.readOnlyMode !== undefined) base.readOnlyMode = fileConfig.readOnlyMode;
        if (fileConfig.websocketUrl) base.websocketUrl = fileConfig.websocketUrl;
        if (fileConfig.websocketPort) base.websocketPort = fileConfig.websocketPort;
        if (fileConfig.commandTimeout) base.commandTimeout = fileConfig.commandTimeout;
        if (fileConfig.gameBridgeUrl) base.gameBridgeUrl = fileConfig.gameBridgeUrl;
        if (fileConfig.gameBridgePort) base.gameBridgePort = fileConfig.gameBridgePort;
        if (fileConfig.allowUnsafeGameCommands !== undefined) base.allowUnsafeGameCommands = fileConfig.allowUnsafeGameCommands;
        break; // Use first config found
      }
    } catch {
      // Silently ignore invalid config file and try next
    }
  }

  // Apply explicit overrides last (highest priority)
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Singleton config instance
// ---------------------------------------------------------------------------

export const config = {
  SERVER_NAME: 'godot-mcp-server',
  SERVER_VERSION: '1.0.0',
  ...getDefaultConfig(),
};
