/**
 * Running Godot process management.
 *
 * Handles launching the Godot editor, running projects with debug output
 * capture, and graceful termination.  Extracted from the monolith's
 * `activeProcess` / `lastProcess` pattern.
 */

import { ChildProcess, spawn, execSync } from 'child_process';
import { logDebug, logInfo, logError } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GodotProcess {
    process: ChildProcess;
    output: string[];
    errors: string[];
    startedAt: number;
}

export interface DebugOutput {
    output: string[];
    errors: string[];
}

// ---------------------------------------------------------------------------
// ProcessManager (singleton)
// ---------------------------------------------------------------------------

export class ProcessManager {
    private activeProcess: GodotProcess | null = null;
    private lastProcess: GodotProcess | null = null;

    // -------------------------------------------------------------------------
    // Launch editor
    // -------------------------------------------------------------------------

    /**
     * Launch the Godot editor for a project.
     * The editor runs as a detached process — we don't capture its output.
     */
    async launchEditor(projectPath: string, godotPath: string): Promise<void> {
        logInfo(`Launching Godot editor for: ${projectPath}`);

        const child = spawn(godotPath, ['--editor', '--path', projectPath], {
            detached: true,
            stdio: 'ignore',
        });

        child.unref();
        logDebug(`Editor launched (PID: ${child.pid})`);
    }

    // -------------------------------------------------------------------------
    // Run project
    // -------------------------------------------------------------------------

    /**
     * Run a Godot project in debug mode, capturing stdout/stderr.
     * If a project is already running it will be stopped first.
     *
     * @param scene  Optional scene path to run (relative to project).
     */
    async runProject(
        projectPath: string,
        godotPath: string,
        scene?: string,
    ): Promise<DebugOutput> {
        // Stop the currently running project if any
        if (this.activeProcess) {
            logDebug('Stopping existing project before launching a new one');
            this.stopProject();
        }

        const args = ['--path', projectPath];
        if (scene) {
            args.push(scene);
        }

        logInfo(`Running project: ${projectPath}${scene ? ` (${scene})` : ''}`);

        const child = spawn(godotPath, args, { stdio: 'pipe' });

        const proc: GodotProcess = {
            process: child,
            output: [],
            errors: [],
            startedAt: Date.now(),
        };

        child.stdout?.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            if (line) {
                proc.output.push(line);
                logDebug(`[stdout] ${line}`);
            }
        });

        child.stderr?.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            if (line) {
                proc.errors.push(line);
                logDebug(`[stderr] ${line}`);
            }
        });

        child.on('close', (code) => {
            logInfo(`Project exited with code ${code}`);
            this.lastProcess = proc;
            if (this.activeProcess === proc) {
                this.activeProcess = null;
            }
        });

        child.on('error', (err) => {
            logError(`Failed to start project: ${err.message}`);
            proc.errors.push(`Process error: ${err.message}`);
        });

        this.activeProcess = proc;

        // Wait briefly for initial output (or immediate crashes)
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return { output: proc.output, errors: proc.errors };
    }

    // -------------------------------------------------------------------------
    // Debug output
    // -------------------------------------------------------------------------

    /**
     * Get accumulated stdout/stderr from the running (or last-run) project.
     */
    getDebugOutput(): DebugOutput | null {
        const proc = this.activeProcess ?? this.lastProcess;
        if (!proc) return null;
        return { output: [...proc.output], errors: [...proc.errors] };
    }

    // -------------------------------------------------------------------------
    // Stop project
    // -------------------------------------------------------------------------

    /**
     * Kill the running project and return its final output.
     */
    stopProject(): DebugOutput | null {
        if (!this.activeProcess) return null;

        logInfo('Stopping running project');
        const proc = this.activeProcess;

        this.killProcess(proc.process);

        this.lastProcess = proc;
        this.activeProcess = null;

        return { output: [...proc.output], errors: [...proc.errors] };
    }

    /**
     * Kill a child process, using platform-appropriate methods.
     * On Windows, SIGTERM is ignored so we use `taskkill /F /T`.
     */
    private killProcess(child: ChildProcess): void {
        try {
            if (process.platform === 'win32' && child.pid) {
                // /F = force, /T = tree kill (also kills child processes)
                execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
            } else {
                child.kill('SIGKILL');
            }
        } catch (err) {
            logError(`Error killing process: ${(err as Error).message}`);
        }
    }

    // -------------------------------------------------------------------------
    // State queries
    // -------------------------------------------------------------------------

    /** Whether a project is currently running. */
    isRunning(): boolean {
        return this.activeProcess !== null;
    }

    // -------------------------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------------------------

    /** Kill any running process (call on server shutdown). */
    cleanup(): void {
        if (this.activeProcess) {
            logDebug('Cleaning up active process');
            this.killProcess(this.activeProcess.process);
            this.activeProcess = null;
        }
    }
}

// ---------------------------------------------------------------------------
// Singleton access
// ---------------------------------------------------------------------------

let instance: ProcessManager | null = null;

export function getProcessManager(): ProcessManager {
    if (!instance) {
        instance = new ProcessManager();
    }
    return instance;
}
