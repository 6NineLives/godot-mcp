import { z } from 'zod';

/**
 * Interface for FastMCP tool definition.
 */
export interface MCPTool<T = any> {
  name: string;
  description: string;
  parameters: z.ZodType<T>;
  execute: (args: T) => Promise<string>;
}

/**
 * Generic response from a Godot command (via WebSocket).
 */
export interface CommandResult {
  [key: string]: any;
}

/**
 * MCP tool response content item.
 */
export interface ToolResponseContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * Standardized tool response (matches MCP protocol).
 */
export interface ToolResponse {
  content: ToolResponseContent[];
  isError?: true;
}