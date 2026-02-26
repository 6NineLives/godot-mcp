/**
 * Scene/resource file validation tools (headless — no WebSocket required).
 *
 * These tools parse `.tscn` and `.tres` files to detect common syntax errors
 * (invalid colors, malformed vectors, bad property values, missing resources)
 * WITHOUT needing the Godot editor to be running.
 *
 * Designed to be called after any AI-generated scene creation to catch errors
 * before the user tries to open the scene in Godot.
 */

import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { MCPTool } from '../../utils/types.js';
import { validatePath, isGodotProject, detectProjectPath } from '../../core/path-manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ValidationError {
    line: number;
    column?: number;
    severity: 'error' | 'warning';
    message: string;
    context: string;         // the raw line content
    fixable: boolean;        // whether auto-fix can handle it
    fixDescription?: string; // what the auto-fix would do
}

interface ValidationResult {
    valid: boolean;
    filePath: string;
    totalLines: number;
    errors: ValidationError[];
    warnings: ValidationError[];
    summary: string;
}

// ---------------------------------------------------------------------------
// Validators — individual checks
// ---------------------------------------------------------------------------

/** Validate Color(...) expressions. */
function validateColor(line: string, lineNum: number): ValidationError | null {
    const colorMatch = line.match(/Color\(([^)]*)\)/g);
    if (!colorMatch) return null;

    for (const match of colorMatch) {
        const inner = match.slice(6, -1); // strip "Color(" and ")"
        const parts = inner.split(',').map(p => p.trim());

        // Color can be Color(r, g, b) or Color(r, g, b, a)
        if (parts.length < 3 || parts.length > 4) {
            return {
                line: lineNum,
                severity: 'error',
                message: `Invalid Color: expected 3-4 numeric arguments, got ${parts.length}: ${match}`,
                context: line.trim(),
                fixable: false,
            };
        }

        for (const part of parts) {
            const num = parseFloat(part);
            if (isNaN(num)) {
                return {
                    line: lineNum,
                    severity: 'error',
                    message: `Invalid Color component "${part}" is not a number in: ${match}`,
                    context: line.trim(),
                    fixable: false,
                };
            }
            if (num < 0 || num > 1.0) {
                return {
                    line: lineNum,
                    severity: 'warning',
                    message: `Color component ${num} is outside [0, 1] range in: ${match}`,
                    context: line.trim(),
                    fixable: true,
                    fixDescription: `Clamp ${num} to [0, 1]`,
                };
            }
        }
    }

    return null;
}

/** Validate hex color codes like #RRGGBB or #RRGGBBAA. */
function validateHexColor(line: string, lineNum: number): ValidationError | null {
    const hexMatch = line.match(/"#([^"]*?)"/g);
    if (!hexMatch) return null;

    for (const match of hexMatch) {
        const hex = match.slice(2, -1); // strip the '#' and quotes
        if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) {
            return {
                line: lineNum,
                severity: 'error',
                message: `Invalid hex color code: ${match}. Expected #RRGGBB or #RRGGBBAA`,
                context: line.trim(),
                fixable: false,
            };
        }
    }

    return null;
}

/** Validate Vector2(...) and Vector3(...) expressions. */
function validateVectors(line: string, lineNum: number): ValidationError | null {
    const vecMatches = line.match(/Vector(2|3)\(([^)]*)\)/g);
    if (!vecMatches) return null;

    for (const match of vecMatches) {
        const vecType = match.startsWith('Vector2') ? 2 : 3;
        const inner = match.slice(match.indexOf('(') + 1, -1);
        const parts = inner.split(',').map(p => p.trim());

        if (parts.length !== vecType) {
            return {
                line: lineNum,
                severity: 'error',
                message: `Invalid Vector${vecType}: expected ${vecType} components, got ${parts.length}: ${match}`,
                context: line.trim(),
                fixable: false,
            };
        }

        for (const part of parts) {
            if (isNaN(parseFloat(part))) {
                return {
                    line: lineNum,
                    severity: 'error',
                    message: `Invalid Vector${vecType} component "${part}" is not a number in: ${match}`,
                    context: line.trim(),
                    fixable: false,
                };
            }
        }
    }

    return null;
}

/** Validate PackedVector2Array entries. */
function validatePackedArrays(line: string, lineNum: number): ValidationError | null {
    const packedMatch = line.match(/PackedVector2Array\(([^)]*)\)/g);
    if (!packedMatch) return null;

    for (const match of packedMatch) {
        const inner = match.slice(match.indexOf('(') + 1, -1).trim();
        if (inner.length === 0) continue; // empty array is fine

        const parts = inner.split(',').map(p => p.trim());
        if (parts.length % 2 !== 0) {
            return {
                line: lineNum,
                severity: 'error',
                message: `PackedVector2Array has odd number of values (${parts.length}). Values must come in pairs (x, y).`,
                context: line.trim().substring(0, 100),
                fixable: false,
            };
        }

        for (const part of parts) {
            if (isNaN(parseFloat(part))) {
                return {
                    line: lineNum,
                    severity: 'error',
                    message: `PackedVector2Array has non-numeric value: "${part}"`,
                    context: line.trim().substring(0, 100),
                    fixable: false,
                };
            }
        }
    }

    return null;
}

/** Validate ExtResource and SubResource references. */
function validateResourceRefs(
    line: string,
    lineNum: number,
    extResources: Set<string>,
    subResources: Set<string>,
): ValidationError | null {
    // Check ExtResource references
    const extRefMatch = line.match(/ExtResource\("([^"]+)"\)/g);
    if (extRefMatch) {
        for (const match of extRefMatch) {
            const id = match.slice(13, -2); // strip ExtResource(" and ")
            if (!extResources.has(id)) {
                return {
                    line: lineNum,
                    severity: 'error',
                    message: `Reference to undefined ExtResource: "${id}"`,
                    context: line.trim(),
                    fixable: false,
                };
            }
        }
    }

    // Check SubResource references
    const subRefMatch = line.match(/SubResource\("([^"]+)"\)/g);
    if (subRefMatch) {
        for (const match of subRefMatch) {
            const id = match.slice(13, -2); // strip SubResource(" and ")
            if (!subResources.has(id)) {
                return {
                    line: lineNum,
                    severity: 'error',
                    message: `Reference to undefined SubResource: "${id}"`,
                    context: line.trim(),
                    fixable: false,
                };
            }
        }
    }

    return null;
}

/** Validate that required header fields are present. */
function validateHeader(lines: string[]): ValidationError[] {
    const errors: ValidationError[] = [];

    if (lines.length === 0) {
        errors.push({
            line: 1,
            severity: 'error',
            message: 'File is empty',
            context: '',
            fixable: false,
        });
        return errors;
    }

    const firstLine = lines[0].trim();

    // .tscn files must start with [gd_scene ...]
    // .tres files must start with [gd_resource ...]
    if (!firstLine.startsWith('[gd_scene') && !firstLine.startsWith('[gd_resource')) {
        errors.push({
            line: 1,
            severity: 'error',
            message: `Invalid header. Expected [gd_scene ...] or [gd_resource ...], got: "${firstLine.substring(0, 80)}"`,
            context: firstLine,
            fixable: false,
        });
    }

    // Check format version
    const formatMatch = firstLine.match(/format=(\d+)/);
    if (formatMatch) {
        const format = parseInt(formatMatch[1], 10);
        if (format < 2 || format > 4) {
            errors.push({
                line: 1,
                severity: 'warning',
                message: `Unusual format version: ${format}. Godot 4.x typically uses format=3`,
                context: firstLine,
                fixable: false,
            });
        }
    }

    return errors;
}

/** Check for unclosed brackets in section headers. */
function validateSectionHeaders(line: string, lineNum: number): ValidationError | null {
    // Section headers start with [ and end with ]
    if (line.trimStart().startsWith('[') && !line.trimStart().startsWith('[connection')) {
        const trimmed = line.trim();
        if (!trimmed.endsWith(']')) {
            return {
                line: lineNum,
                severity: 'error',
                message: `Unclosed section header: missing closing ']'`,
                context: trimmed.substring(0, 100),
                fixable: true,
                fixDescription: 'Append missing ]',
            };
        }
    }
    return null;
}

/** Validate property assignment syntax (key = value). */
function validatePropertyAssignment(line: string, lineNum: number): ValidationError | null {
    const trimmed = line.trim();

    // Skip empty lines, comments, section headers, and tile_data multiline arrays
    if (
        !trimmed ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('[') ||
        trimmed.startsWith(')') ||
        /^\d+,/.test(trimmed) // Tile data lines
    ) {
        return null;
    }

    // Property lines should have the format: key = value
    // But some are continuations of multi-line values
    if (trimmed.includes(' = ')) {
        const eqIndex = trimmed.indexOf(' = ');
        const key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 3).trim();

        // Key should not be empty
        if (!key) {
            return {
                line: lineNum,
                severity: 'error',
                message: 'Empty property key',
                context: trimmed,
                fixable: false,
            };
        }

        // Value should not be empty (unless it's a string "")
        if (!value && value !== '""') {
            return {
                line: lineNum,
                severity: 'warning',
                message: `Empty value for property "${key}"`,
                context: trimmed,
                fixable: false,
            };
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

function validateSceneContent(content: string, filePath: string): ValidationResult {
    const lines = content.split('\n');
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    // Collect resource IDs
    const extResources = new Set<string>();
    const subResources = new Set<string>();

    // First pass: collect resource definitions
    for (const line of lines) {
        const extMatch = line.match(/\[ext_resource [^\]]*id="([^"]+)"/);
        if (extMatch) extResources.add(extMatch[1]);

        const subMatch = line.match(/\[sub_resource [^\]]*id="([^"]+)"/);
        if (subMatch) subResources.add(subMatch[1]);
    }

    // Validate header
    const headerErrors = validateHeader(lines);
    for (const err of headerErrors) {
        if (err.severity === 'error') errors.push(err);
        else warnings.push(err);
    }

    // Second pass: validate each line
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        const validators = [
            validateColor(line, lineNum),
            validateHexColor(line, lineNum),
            validateVectors(line, lineNum),
            validatePackedArrays(line, lineNum),
            validateResourceRefs(line, lineNum, extResources, subResources),
            validateSectionHeaders(line, lineNum),
            validatePropertyAssignment(line, lineNum),
        ];

        for (const result of validators) {
            if (result) {
                if (result.severity === 'error') errors.push(result);
                else warnings.push(result);
            }
        }
    }

    const valid = errors.length === 0;
    const summary = valid
        ? `✅ Scene file is valid (${lines.length} lines, ${warnings.length} warning(s))`
        : `❌ Found ${errors.length} error(s) and ${warnings.length} warning(s) in ${lines.length} lines`;

    return {
        valid,
        filePath,
        totalLines: lines.length,
        errors,
        warnings,
        summary,
    };
}

// ---------------------------------------------------------------------------
// Auto-fix function
// ---------------------------------------------------------------------------

function autoFixSceneContent(content: string): { fixed: string; fixesApplied: string[] } {
    const lines = content.split('\n');
    const fixesApplied: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Fix: Clamp color values to [0, 1]
        const colorMatches = line.match(/Color\(([^)]*)\)/g);
        if (colorMatches) {
            let fixedLine = line;
            for (const match of colorMatches) {
                const inner = match.slice(6, -1);
                const parts = inner.split(',').map(p => p.trim());
                const allNumeric = parts.every(p => !isNaN(parseFloat(p)));

                if (allNumeric) {
                    const clamped = parts.map(p => {
                        const n = parseFloat(p);
                        return Math.max(0, Math.min(1, n)).toString();
                    });
                    const fixed = `Color(${clamped.join(', ')})`;
                    if (fixed !== match) {
                        fixedLine = fixedLine.replace(match, fixed);
                        fixesApplied.push(`Line ${i + 1}: Clamped Color values: ${match} → ${fixed}`);
                    }
                }
            }
            lines[i] = fixedLine;
        }

        // Fix: Close unclosed section headers
        const trimmed = line.trimStart();
        if (trimmed.startsWith('[') && !trimmed.startsWith('[connection')) {
            if (!trimmed.trimEnd().endsWith(']')) {
                lines[i] = line.trimEnd() + ']';
                fixesApplied.push(`Line ${i + 1}: Closed unclosed section header`);
            }
        }
    }

    return { fixed: lines.join('\n'), fixesApplied };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const validationTools: MCPTool[] = [
    {
        name: 'validate_scene',
        description:
            'Validate and optionally auto-fix .tscn or .tres files WITHOUT launching Godot. ' +
            'Actions: "check" to validate and report issues, ' +
            '"fix" to validate AND attempt auto-fixes (Color clamping, unclosed sections). ' +
            'Checks for: invalid Color() values, malformed vectors, broken resource references, ' +
            'invalid hex colors, unclosed sections, and more. ' +
            'IMPORTANT: Call this AFTER creating or modifying any scene/resource file.',
        parameters: z.object({
            action: z
                .enum(['check', 'fix'])
                .describe('Which validation action to perform'),
            projectPath: z.string().optional().describe('Optional absolute path to the Godot project directory. If omitted it will be auto-detected.'),
            filePath: z.string().describe(
                'Path to the .tscn or .tres file — either absolute or res:// relative'
            ),
            dryRun: z.boolean().optional().describe(
                'For action "fix": if true, show what would be fixed without modifying the file (default: false)'
            ),
        }),
        execute: async (params: Record<string, unknown>) => {
            const action = params.action as string;
            const projectPath = params.projectPath as string | undefined;
            const filePath = params.filePath as string;

            const resolvedProject = detectProjectPath(projectPath);
            if (!validatePath(resolvedProject)) throw new Error('Invalid project path');
            if (!isGodotProject(resolvedProject)) {
                throw new Error(`Not a Godot project: ${resolvedProject} (resolved from ${projectPath})`);
            }

            // Resolve res:// paths
            let absolutePath = filePath;
            if (filePath.startsWith('res://')) {
                absolutePath = join(resolvedProject, filePath.slice(6));
            }

            if (!existsSync(absolutePath)) {
                throw new Error(
                    `File not found: ${filePath}. ` +
                    `If you just created nodes in the editor, save the scene first ` +
                    `(use manage_scene with action "save") before validating.`
                );
            }

            const ext = extname(absolutePath).toLowerCase();
            if (ext !== '.tscn' && ext !== '.tres') {
                throw new Error(
                    `Invalid file type: ${ext}. This tool only validates .tscn and .tres files.`
                );
            }

            const content = readFileSync(absolutePath, 'utf8');

            switch (action) {
                case 'check': {
                    const result = validateSceneContent(content, filePath);
                    return JSON.stringify(result, null, 2);
                }

                case 'fix': {
                    const dryRun = params.dryRun as boolean | undefined;

                    // Validate before fix
                    const beforeResult = validateSceneContent(content, filePath);

                    // Attempt auto-fix
                    const { fixed, fixesApplied } = autoFixSceneContent(content);

                    // Validate after fix
                    const afterResult = validateSceneContent(fixed, filePath);

                    if (!dryRun && fixesApplied.length > 0) {
                        writeFileSync(absolutePath, fixed, 'utf8');
                    }

                    return JSON.stringify({
                        before: {
                            errors: beforeResult.errors.length,
                            warnings: beforeResult.warnings.length,
                        },
                        fixesApplied: fixesApplied.length > 0 ? fixesApplied : ['No auto-fixable issues found'],
                        dryRun: dryRun ?? false,
                        fileModified: !dryRun && fixesApplied.length > 0,
                        after: {
                            valid: afterResult.valid,
                            errors: afterResult.errors,
                            warnings: afterResult.warnings,
                            summary: afterResult.summary,
                        },
                        recommendation: afterResult.errors.length > 0
                            ? 'Some errors remain that cannot be auto-fixed. Review the errors above and fix manually, ' +
                            'or use get_project_diagnostics to run Godot\'s full validation.'
                            : '✅ All checks pass after auto-fix.',
                    }, null, 2);
                }

                default:
                    throw new Error(`Unknown action: ${action}`);
            }
        },
    },
];
