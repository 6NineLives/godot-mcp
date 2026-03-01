# Godot MCP (Model Context Protocol)

## Project Overview
Godot MCP provides a comprehensive, production-ready integration between Large Language Models (LLMs) and the Godot Engine (versions 4.x). It creates a unified Model Context Protocol interface allowing AI assistants to intelligently read, write, and manipulate Godot project files, interact with the live Godot Editor, and perform End-to-End (E2E) testing on running games. By consolidating multiple AI-to-Godot features into a single robust toolkit, Godot MCP dramatically lowers the friction of AI-assisted game development.

## Installation & Usage

### 1. Prerequisites
- Node.js (v18 or higher)
- Godot Engine 4.x
- Supported MCP client (e.g., Claude Desktop)

### 2. Setup the Server
```bash
git clone https://github.com/6NineLives/godot-mcp
cd godot-mcp/server
npm install
npm run build
```

### 3. Configure the MCP Client (Claude Desktop Example)
Add the following configuration to your `mcp config json`:
```json
{
  "mcpServers": {
    "godot-mcp": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_GODOT_MCP>/server/dist/index.js"],
      "env": {
        "GODOT_PATH": "<OPTIONAL_ABSOLUTE_PATH_TO_GODOT_EXECUTABLE>"
      }
    }
  }
}
```

### 4. Godot Addon Installation
1. Open your Godot project.
2. Copy the `addons/godot_mcp` folder from this repository into your project's `addons/` directory.
3. Ensure the `godot_mcp` plugin is enabled in Godot via **Project > Project Settings > Plugins**.
4. Start your MCP Client. The server will seamlessly connect to the Godot WebSocket.

## Feature List

*   **Live Editor Manipulation**: Modify nodes, properties, and scenes in real-time within the Godot Editor.
*   **Deep Project Context**: Read and analyze scripts, scene structures (`.tscn`), and project files dynamically.
*   **Version-Aware Godot Docs**: Automatically query Godot documentation matching your specific engine version.
*   **End-to-End Game Bridge testing**: Play, test, and assert logic in live running games via simulated inputs and state queries.
*   **Advanced Diagnostics**: View diagnostics, validate scenes, and debug live errors automatically.
*   **Consolidated Architecture**: Minimal tool footprint heavily utilizing `action` parameters to conserve AI context windows.
*   **Auto-Screenshot Loop**: Periodically captures visual screenshots of the editor or running game state to provide AI with continuous visual context.
*   **Bug Fix Loop**: Automatically collects stack traces from the Godot engine, analyzes runtime errors, and iteratively proposes code fixes.
*   **Scene Tree Viewer**: Interactive web-based visualizer for inspecting the live Godot scene tree and node properties via a browser.
*   **Intelligent Path Detection**: Seamlessly detects correct Godot project paths and environment variables, even when loaded via external IDEs.
*   **Robust Connection Handling**: Enterprise-grade WebSocket connections featuring command queuing, exponential backoff, and large payload buffering.
*   **Universal Asset Resolution**: Resolves internal Godot UUIDs (`uid://...` or `.uid` files) dynamically to absolute file paths, ensuring seamless AI context mapping.

## MCP Tools Reference

| Tool Name | Description | Key Parameters |
| :--- | :--- | :--- |
| `manage_project` | Project-level operations | `action` (info, tree, stats), `directory` |
| `manage_project_config` | Modify project.godot or export settings | `action` (read, write), `section`, `key`, `value` |
| `manage_asset` | Resolve or inspect asset paths and UUIDs | `action` (resolve, get_uid), `file_path`, `uid` |
| `manage_script` | Create, read, update, or analyze GDScripts | `action` (create, read, edit), `file_path`, `content` |
| `manage_scene` | Scene-level operations | `action` (open, save, run, structure), `scene_path` |
| `manage_node` | Node-level edits within the live editor | `action` (create, delete, update, get), `node_path`, `properties` |
| `manage_physics` | Inspect or edit physics shapes and layers | `action` (get_layer, set_layer), `node_path` |
| `manage_animation` | Control AnimationPlayers in the editor | `action` (get_list, play, stop), `node_path`, `anim_name` |
| `manage_ui` | Inspect or modify Control nodes | `action` (get_theme, set_anchors), `node_path` |
| `manage_audio` | Audit or manipulate audio streams | `action` (get_buses, set_volume), `bus_name` |
| `manage_signal` | Connect or disconnect Godot signals | `action` (connect, disconnect), `source_node`, `signal_name`, `target_node`, `method_name` |
| `manage_game_bridge` | Connect to or configure a live running game | `action` (status, reset, ping) |
| `game_scene` | Get node trees from the running game | `action` (get_tree, get_node), `node_path` |
| `game_input` | Simulate input events in the running game | `action` (press, release, mouse_move), `input_name` |
| `game_state` | Query properties and execution state | `action` (get_property, call_method), `node_path`, `property` |
| `game_wait` | Pause execution to wait for visual updates | `action` (wait_frames, wait_seconds), `amount` |
| `godot_docs` | Query Godot Engine documentation | `action` (search, get_class), `query` |
| `execute_editor_script` | Run arbitrary GDScript within the editor | `script_code` |
| `visualize_project` | Launch the web-based project visualizer | `port` |
| `capture_vision` | Capture screenshots of the editor (if supported) | `format`, `quality` |
| `inspect_project` | Deep-scan relations and usages | `action` (find_usage), `target` |
| `debug_project` | Fetch logs and stack traces | `action` (get_errors, clear_logs) |
| `validate_scene` | Check for broken dependencies | `scene_path` |
| `run_and_verify` | Workflow tool to execute and assert correctness | `scene_path`, `assertions` |
| `get_project_diagnostics` | Aggregate warnings across the ecosystem | `include_warnings` |
| `search_project` | Full-text or regex search across scripts | `query`, `use_regex`, `file_pattern` |
| `semantic_search` | Search code by semantic meaning | `query`, `threshold` |
| `get_project_assets` | Get a comprehensive list of assets | `resource_type` |
| `get_project_context` | Retrieve summarized current working context | `depth` |

## Acknowledgements

This project builds upon the foundational work of several existing Model Context Protocol (MCP) implementations for the Godot Engine. We would like to express our gratitude to the original maintainers and communities behind these repositories:

*   **godot-mcp-plugin**: ([tomyud1/godot-mcp](https://github.com/tomyud1/godot-mcp))
*   **godot-mcp-scene**: ([Derfirm/godot-mcp](https://github.com/Derfirm/godot-mcp))
*   **godot-mcp-docs**: ([Nihilantropy/godot-mcp-docs](https://github.com/Nihilantropy/godot-mcp-docs))
*   **godot-mcp-solo**: ([Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp))
*   **godot_mcp_uid**: ([bradypp/godot-mcp](https://github.com/bradypp/godot-mcp))

We sincerely thank the original maintainers, contributors, and the broader Godot and open-source communities who laid the groundwork for these tools. Their specialized prototypes proved the viability of connecting Large Language Models to Godot via MCP and provided essential insights that made this unified, production-ready toolchain possible.
