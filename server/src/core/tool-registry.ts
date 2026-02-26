/**
 * Centralized tool registry with read-only mode support.
 *
 * Every tool in the server is registered here with:
 *   - Its FastMCP tool definition (name, description, parameters, execute)
 *   - A `readOnly` flag indicating whether it mutates state
 *   - A `category` for organizational grouping
 *
 * When READ_ONLY_MODE is enabled, write tools are filtered out so the
 * AI assistant can only inspect — not modify — the Godot project.
 */

import { READ_ONLY_MODE } from '../config/config.js';
import { logInfo, logDebug } from '../utils/logger.js';
import type { MCPTool } from '../utils/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolCategory =
    | 'node'
    | 'scene'
    | 'script'
    | 'editor'
    | 'project'
    | 'docs'
    | 'vision'
    | 'system'
    | 'asset'
    | 'search'
    | 'workflow'
    | 'validation'
    | 'discovery'
    | 'context'
    | 'debug'
    | 'signal'
    | 'config'
    | 'physics'
    | 'animation'
    | 'ui'
    | 'inspect'
    | 'visualizer'
    | 'game_bridge';

export interface ToolRegistration {
    tool: MCPTool;
    readOnly: boolean;
    category: ToolCategory;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
    private registry = new Map<string, ToolRegistration>();

    /**
     * Register a single tool.
     */
    register(registration: ToolRegistration): void {
        if (this.registry.has(registration.tool.name)) {
            logDebug(`Overwriting existing tool: ${registration.tool.name}`);
        }
        this.registry.set(registration.tool.name, registration);
        logDebug(`Registered tool: ${registration.tool.name} [${registration.category}] readOnly=${registration.readOnly}`);
    }

    /**
     * Bulk-register an array of tools sharing the same category and readOnly flag.
     */
    registerBatch(
        tools: MCPTool[],
        options: { readOnly: boolean; category: ToolCategory },
    ): void {
        for (const tool of tools) {
            this.register({
                tool,
                readOnly: options.readOnly,
                category: options.category,
            });
        }
    }

    /**
     * Get all tools that should be exposed to the MCP client.
     * If READ_ONLY_MODE is enabled, only read-only tools are returned.
     */
    getFilteredTools(): MCPTool[] {
        const all = Array.from(this.registry.values());

        if (!READ_ONLY_MODE) {
            return all.map((r) => r.tool);
        }

        const filtered = all.filter((r) => r.readOnly);
        logInfo(`[READ_ONLY_MODE] Filtered out ${all.length - filtered.length} write tools`);
        return filtered.map((r) => r.tool);
    }

    /**
     * Get all registered tool names.
     */
    getToolNames(): string[] {
        return Array.from(this.registry.keys());
    }

    /**
     * Get names grouped by category.
     */
    getToolsByCategory(): Record<string, string[]> {
        const result: Record<string, string[]> = {};
        for (const [name, reg] of this.registry) {
            if (!result[reg.category]) result[reg.category] = [];
            result[reg.category].push(name);
        }
        return result;
    }

    /**
     * Check whether a tool is registered.
     */
    has(name: string): boolean {
        return this.registry.has(name);
    }

    /**
     * Get the registration for a tool by name.
     */
    get(name: string): ToolRegistration | undefined {
        return this.registry.get(name);
    }

    /**
     * Total number of registered tools (before filtering).
     */
    get size(): number {
        return this.registry.size;
    }
}

// ---------------------------------------------------------------------------
// Singleton access
// ---------------------------------------------------------------------------

let instance: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
    if (!instance) {
        instance = new ToolRegistry();
    }
    return instance;
}
