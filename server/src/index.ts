#!/usr/bin/env node
import { FastMCP } from 'fastmcp';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Consolidated tool modules
import { nodeTools } from './tools/scene/node_tools.js';
import { scriptTools } from './tools/project/script_tools.js';
import { sceneTools } from './tools/scene/scene_tools.js';
import { editorTools } from './tools/system/editor_tools.js';
import { docTools } from './tools/system/doc_tools.js';
import { visionTools } from './tools/system/vision_tools.js';
import { projectTools } from './tools/project/project_tools.js';
import { assetTools } from './tools/project/asset_tools.js';
import { searchTools } from './tools/core/search_tools.js';
import { workflowTools } from './tools/system/workflow_tools.js';
import { validationTools } from './tools/core/validation_tools.js';
import { discoveryTools } from './tools/core/discovery_tools.js';
import { contextTools } from './tools/core/context_tools.js';
import { debugTools } from './tools/system/debug_tools.js';
import { signalTools } from './tools/project/signal_tools.js';
import { configTools } from './tools/project/config_tools.js';
import { physicsTools } from './tools/scene/physics_tools.js';
import { animationTools } from './tools/scene/animation_tools.js';
import { audioTools } from './tools/system/audio_tools.js';
import { uiTools } from './tools/scene/ui_tools.js';
import { inspectTools } from './tools/system/inspect_tools.js';
import { visualizerTools } from './tools/system/visualizer_tools.js';
import { gameBridgeTools } from './tools/game/game_bridge_tools.js';
import { gameSceneTools } from './tools/scene/game_scene_tools.js';
import { gameInputTools } from './tools/game/game_input_tools.js';
import { gameStateTools } from './tools/game/game_state_tools.js';
import { gameWaitTools } from './tools/game/game_wait_tools.js';

// MCP Prompts
import { godotPrompts } from './prompts/godot_prompts.js';

// Infrastructure
import { getGodotConnection } from './utils/godot_connection.js';
import { getToolRegistry } from './core/tool-registry.js';
import { getProcessManager } from './core/process-manager.js';
import { detectGodotPath, setClientRoots } from './core/path-manager.js';
import { resetGameBridge } from './core/game_bridge.js';
import { logInfo, logWarn, logError, logDebug } from './utils/logger.js';
import { loadConfig } from './config/config.js';

// Resources
import {
  sceneListResource,
  sceneStructureResource,
} from './resources/scene_resources.js';
import {
  scriptListResource,
} from './resources/script_resources.js';
import {
  projectStructureResource,
  projectSettingsResource,
  projectResourcesResource,
} from './resources/project_resources.js';
import {
  editorStateResource,
  selectedNodeResource,
  currentScriptResource,
} from './resources/editor_resources.js';

// ---------------------------------------------------------------------------
// Install command — must run before the async server starts so that
// process.exit() is clean and no async I/O is left dangling.
// ---------------------------------------------------------------------------
function runInstall(): void {
  // Use console.log (stdout) for all install output so it is always visible
  // in Windows terminals (CMD / PowerShell).  The rest of the server uses
  // console.error / stderr because MCP communicates over stdout, but this
  // CLI path is user-facing.
  console.log('[INFO] Running Godot MCP installation utility...');

  // Resolve the source addon directory relative to THIS script file.
  // When installed via npx, __dirname is:
  //   <npx_cache>/node_modules/@xianlee/godot-mcp/server/dist
  // Two levels up (.., ..) gives the package root which contains addons/.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Try the standard path first, then walk further up as a fallback in case
  // the package is extracted at a different depth (e.g. workspace hoisting).
  let sourceAddonDir = '';
  const candidates = [
    path.resolve(__dirname, '..', '..', 'addons', 'godot_mcp'),
    path.resolve(__dirname, '..', '..', '..', 'addons', 'godot_mcp'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      sourceAddonDir = candidate;
      break;
    }
  }

  if (!sourceAddonDir) {
    console.log('[ERROR] Could not locate the addon source directory.');
    console.log('[ERROR] Searched in:');
    for (const c of candidates) {
      console.log(`[ERROR]   ${c}`);
    }
    console.log('[ERROR] The npm package may be corrupted. Try reinstalling:');
    console.log('[ERROR]   npm install -g @xianlee/godot-mcp');
    process.exit(1);
  }

  const targetDir = path.join(process.cwd(), 'addons');
  const targetAddonDir = path.join(targetDir, 'godot_mcp');
  console.log(`[INFO] Source : ${sourceAddonDir}`);
  console.log(`[INFO] Target : ${targetAddonDir}`);

  try {
    if (fs.existsSync(targetAddonDir)) {
      console.log('[WARN] Addon directory already exists — overwriting...');
      fs.rmSync(targetAddonDir, { recursive: true, force: true });
    }

    fs.mkdirSync(targetDir, { recursive: true });
    copyDirSync(sourceAddonDir, targetAddonDir);
  } catch (err) {
    console.log(`[ERROR] Installation failed: ${err}`);
    if (process.platform === 'win32') {
      console.log('[ERROR] On Windows you may need to:');
      console.log('[ERROR]   • Run your terminal as Administrator, OR');
      console.log('[ERROR]   • Enable Long Path support (gpedit or registry), OR');
      console.log('[ERROR]   • Manually copy the addon from the npm cache.');
    }
    process.exit(1);
  }

  console.log('[INFO] ✓ Installation successful!');
  console.log('[INFO] Next steps:');
  console.log('[INFO]   1. Open your Godot project.');
  console.log('[INFO]   2. Go to Project -> Project Settings -> Plugins.');
  console.log('[INFO]   3. Enable the "Godot MCP" plugin.');
  process.exit(0);
}

/**
 * Cross-platform recursive directory copy.
 *
 * `fs.cpSync` (Node ≥ 16.7) is used when available; otherwise we fall back
 * to a manual implementation.  The manual path also avoids the `EPERM`
 * errors that `fs.cpSync` can produce on Windows when copying from a
 * read-only location such as the npm cache.
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Run install before the async server starts so that process.exit() is clean.
if (process.argv.slice(2).includes('install')) {
  runInstall();
}

/**
 * Main entry point for the consolidated Godot MCP server.
 */
async function main() {

  logInfo('Starting Godot MCP server...');

  const config = loadConfig();

  // Create FastMCP instance
  const server = new FastMCP({
    name: 'GodotMCP',
    version: '1.0.0',
  });

  // ---------------------------------------------------------------------------
  // Register all tools via the ToolRegistry
  // ---------------------------------------------------------------------------
  const registry = getToolRegistry();

  // WebSocket-based tools (require Godot addon running)
  registry.registerBatch(nodeTools, { readOnly: false, category: 'node' });
  registry.registerBatch(scriptTools, { readOnly: false, category: 'script' });
  registry.registerBatch(sceneTools, { readOnly: false, category: 'scene' });
  registry.registerBatch(editorTools, { readOnly: false, category: 'editor' });
  registry.registerBatch(docTools, { readOnly: true, category: 'docs' });
  registry.registerBatch(visionTools, { readOnly: false, category: 'vision' });

  // Headless tools (no addon required)
  registry.registerBatch(projectTools, { readOnly: false, category: 'project' });
  registry.registerBatch(assetTools, { readOnly: false, category: 'asset' });

  // Search & discovery tools (all read-only)
  registry.registerBatch(searchTools, { readOnly: true, category: 'search' });
  registry.registerBatch(discoveryTools, { readOnly: true, category: 'discovery' });
  registry.registerBatch(contextTools, { readOnly: true, category: 'context' });

  // Workflow tools (read-only — they observe but don't mutate)
  registry.registerBatch(workflowTools, { readOnly: true, category: 'workflow' });

  // Validation tools (consolidated — check is read-only, fix is write)
  registry.registerBatch(validationTools, { readOnly: false, category: 'validation' });

  // Debug tools (consolidated — mixed read/write actions)
  registry.registerBatch(debugTools, { readOnly: false, category: 'debug' });

  // Signal tools (consolidated — mixed read/write actions)
  registry.registerBatch(signalTools, { readOnly: false, category: 'signal' });

  // Config / Physics / Animation / UI (write — modify project)
  registry.registerBatch(configTools, { readOnly: false, category: 'config' });
  registry.registerBatch(physicsTools, { readOnly: false, category: 'physics' });
  registry.registerBatch(animationTools, { readOnly: false, category: 'animation' });
  registry.registerBatch(uiTools, { readOnly: false, category: 'ui' });

  // Introspection & visualization (read-only — inspect but don't mutate)
  registry.registerBatch(inspectTools, { readOnly: false, category: 'inspect' });
  registry.registerBatch(visualizerTools, { readOnly: true, category: 'visualizer' });

  // Game E2E bridge tools (write — interact with running game)
  registry.registerBatch(gameBridgeTools, { readOnly: false, category: 'game_bridge' });
  registry.registerBatch(gameSceneTools, { readOnly: false, category: 'game_bridge' });
  registry.registerBatch(gameInputTools, { readOnly: false, category: 'game_bridge' });
  registry.registerBatch(gameStateTools, { readOnly: true, category: 'game_bridge' });
  registry.registerBatch(gameWaitTools, { readOnly: true, category: 'game_bridge' });

  // Apply READ_ONLY_MODE filtering and register with FastMCP
  const filteredTools = registry.getFilteredTools();
  for (const tool of filteredTools) {
    server.addTool(tool);
  }

  logInfo(`Registered ${filteredTools.length} tools (${registry.size} total, ${config.readOnlyMode ? 'READ_ONLY' : 'READ_WRITE'} mode)`);
  logDebug(`Tools by category: ${JSON.stringify(registry.getToolsByCategory())}`);

  // ---------------------------------------------------------------------------
  // Register MCP prompts
  // ---------------------------------------------------------------------------
  for (const prompt of godotPrompts) {
    server.addPrompt(prompt);
  }

  logInfo(`Registered ${godotPrompts.length} MCP prompts`);

  // ---------------------------------------------------------------------------
  // Register all resources
  // ---------------------------------------------------------------------------
  server.addResource(sceneListResource);
  server.addResource(scriptListResource);
  server.addResource(projectStructureResource);
  server.addResource(projectSettingsResource);
  server.addResource(projectResourcesResource);
  server.addResource(editorStateResource);
  server.addResource(selectedNodeResource);
  server.addResource(currentScriptResource);
  server.addResource(sceneStructureResource);

  // ---------------------------------------------------------------------------
  // Detect Godot path on startup (for headless tools)
  // ---------------------------------------------------------------------------
  try {
    const godotPath = await detectGodotPath(config.godotPath);
    if (godotPath) {
      logInfo(`Godot detected: ${godotPath}`);
    } else {
      logWarn('Godot not found — headless tools will fail until GODOT_PATH is set');
    }
  } catch (error) {
    logWarn(`Godot detection failed: ${(error as Error).message}`);
  }

  // ---------------------------------------------------------------------------
  // Try to connect to Godot editor addon (WebSocket)
  // ---------------------------------------------------------------------------
  try {
    const godot = getGodotConnection({
      url: config.websocketUrl,
      timeout: config.commandTimeout,
    });
    await godot.connect();
    logInfo('Connected to Godot WebSocket server (live editor mode)');
  } catch (error) {
    logWarn(`Could not connect to Godot addon: ${(error as Error).message}`);
    logWarn('WebSocket tools will retry when commands are executed');
  }

  // ---------------------------------------------------------------------------
  // Capture IDE workspace roots when client connects
  // The MCP protocol sends workspace folders during initialization —
  // these are the actual project folders open in the IDE, NOT process.cwd().
  // ---------------------------------------------------------------------------
  server.on('connect', (event) => {
    const session = event.session;
    const roots = session.roots ?? [];
    if (roots.length > 0) {
      logInfo(`IDE workspace roots received: ${roots.map(r => r.uri).join(', ')}`);
      setClientRoots(roots);
    } else {
      logDebug('No workspace roots from client — will fall back to CWD detection');
    }
    // Also listen for changes (user opens a different folder mid-session)
    session.on('rootsChanged', (event) => {
      const newRoots = event.roots ?? [];
      logInfo(`IDE workspace roots updated: ${newRoots.map(r => r.uri).join(', ')}`);
      setClientRoots(newRoots);
    });
  });

  // ---------------------------------------------------------------------------
  // Start the MCP server (stdio transport)
  // ---------------------------------------------------------------------------
  server.start({ transportType: 'stdio' });
  logInfo('Godot MCP server started (stdio transport)');

  // ---------------------------------------------------------------------------
  // Cleanup handlers
  // ---------------------------------------------------------------------------
  const cleanup = () => {
    logInfo('Shutting down Godot MCP server...');
    try {
      getGodotConnection().disconnect();
    } catch {
      // Ignore if not connected
    }
    try {
      resetGameBridge();
    } catch {
      // Ignore if not connected
    }
    getProcessManager().cleanup();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// Start the server
main().catch((error) => {
  logError(`Failed to start Godot MCP server: ${error}`);
  process.exit(1);
});
