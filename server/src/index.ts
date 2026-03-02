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

/**
 * Main entry point for the consolidated Godot MCP server.
 */
async function main() {
  // ---------------------------------------------------------------------------
  // Check for CLI args (e.g. `npx godot-mcp install`)
  // ---------------------------------------------------------------------------
  const args = process.argv.slice(2);
  if (args.includes('install')) {
    logInfo('Running Godot MCP installation utility...');
    const targetDir = path.join(process.cwd(), 'addons');

    // We are running from dist/index.js, so we need to step up to the repository root
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const rootDir = path.resolve(__dirname, '..', '..');
    const sourceAddonDir = path.join(rootDir, 'addons', 'godot_mcp');

    if (!fs.existsSync(sourceAddonDir)) {
      logError(`Could not locate source addon at ${sourceAddonDir}`);
      process.exit(1);
    }

    const targetAddonDir = path.join(targetDir, 'godot_mcp');
    logInfo(`Installing Godot MCP addon to: ${targetAddonDir}`);

    if (fs.existsSync(targetAddonDir)) {
      logWarn('Addon directory already exists! Overwriting...');
      fs.rmSync(targetAddonDir, { recursive: true, force: true });
    }

    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(sourceAddonDir, targetAddonDir, { recursive: true });

    logInfo('✓ Installation successful!');
    logInfo('Next steps:');
    logInfo('  1. Open your Godot project.');
    logInfo('  2. Go to Project -> Project Settings -> Plugins.');
    logInfo('  3. Enable the "Godot MCP" plugin.');
    process.exit(0);
  }

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
