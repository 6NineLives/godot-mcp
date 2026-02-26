import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logInfo, logError, logDebug, logWarn } from './logger.js';

const execFileAsync = promisify(execFile);

// Base URL for Godot docs archive by branch name
const getDocsUrl = (branch: string) => `https://github.com/godotengine/godot-docs/archive/refs/heads/${branch}.zip`;

// Path to store documentation versions
const getDocsDir = (branch: string) => path.resolve(process.cwd(), `docs_cache_${branch}`);

export class DocsManager {
  private static instance: DocsManager;
  private initialized = false;
  private currentBranch = 'master';

  private constructor() { }

  static getInstance(): DocsManager {
    if (!DocsManager.instance) {
      DocsManager.instance = new DocsManager();
    }
    return DocsManager.instance;
  }

  // Helper to get system Godot version branch (e.g., '4.3', '3.5')
  private async determineGodotBranch(): Promise<string> {
    try {
      // Import dynamically to avoid circular dependencies if any
      const { detectGodotPath } = await import('../core/path-manager.js');
      const godotPath = await detectGodotPath();
      if (godotPath) {
        const { stdout } = await execFileAsync(godotPath, ['--version']);
        // e.g. "4.3.stable.official..." -> match "4.3"
        const match = stdout.trim().match(/^(\d+\.\d+)/);
        if (match && match[1]) {
          logInfo(`Detected Godot version ${match[1]}, using branch: ${match[1]}`);
          return match[1];
        }
      }
    } catch (err) {
      logWarn(`Could not detect Godot version for docs, defaulting to master. Error: ${(err as Error).message}`);
    }
    return 'master';
  }

  async ensureDocs(): Promise<void> {
    if (!this.initialized) {
      this.currentBranch = await this.determineGodotBranch();
      this.initialized = true;
    }

    const docsDir = getDocsDir(this.currentBranch);
    if (fs.existsSync(docsDir)) return;

    logInfo(`Downloading Godot documentation for branch: ${this.currentBranch}...`);
    await this.downloadAndExtractDocs();
  }

  private async downloadAndExtractDocs(): Promise<void> {
    const zipPath = path.join(process.cwd(), `godot-docs-${this.currentBranch}.zip`);
    const docsUrl = getDocsUrl(this.currentBranch);
    const docsDir = getDocsDir(this.currentBranch);

    // Download using follow-redirect-capable fetch (Node 18+)
    try {
      const response = await fetch(docsUrl, { redirect: 'follow' });

      if (!response.ok) {
        throw new Error(`Failed to download docs: HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(zipPath, buffer);
    } catch (err) {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      throw new Error(`Failed to download Godot docs: ${(err as Error).message}`);
    }

    logInfo('Extracting documentation...');

    // Extract using safe execFile (no shell injection)
    try {
      if (process.platform === 'win32') {
        await execFileAsync('powershell', [
          '-NoProfile', '-Command',
          'Expand-Archive',
          '-Path', zipPath,
          '-DestinationPath', docsDir,
          '-Force',
        ]);
      } else {
        if (!fs.existsSync(docsDir)) {
          fs.mkdirSync(docsDir, { recursive: true });
        }
        await execFileAsync('unzip', ['-o', zipPath, '-d', docsDir]);
      }
    } catch (e) {
      logError(`Extraction failed: ${(e as Error).message}`);
      throw e;
    } finally {
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }
    }
  }

  getDocsRoot(): string {
    const docsDir = getDocsDir(this.currentBranch);
    if (!fs.existsSync(docsDir)) return docsDir;

    const files = fs.readdirSync(docsDir);
    if (files.length === 1 && fs.statSync(path.join(docsDir, files[0])).isDirectory()) {
      return path.join(docsDir, files[0]);
    }
    return docsDir;
  }

  async getFileContent(relativePath: string): Promise<string> {
    await this.ensureDocs();
    const root = this.getDocsRoot();
    const filePath = path.join(root, relativePath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${relativePath}`);
    }

    return fs.readFileSync(filePath, 'utf-8');
  }

  async searchFiles(query: string): Promise<string[]> {
    await this.ensureDocs();
    const root = this.getDocsRoot();
    const results: string[] = [];

    const searchDir = (dir: string) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);

        if (file.startsWith('.')) continue;

        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            searchDir(fullPath);
          } else if (file.toLowerCase().includes(query.toLowerCase())) {
            results.push(path.relative(root, fullPath).replace(/\\/g, '/'));
          }
        } catch {
          // Ignore access errors
        }
      }
    };

    searchDir(root);
    return results.slice(0, 50);
  }

  async getClassReference(className: string): Promise<string> {
    await this.ensureDocs();

    const fileName = `classes/class_${className.toLowerCase()}.rst`;
    try {
      return await this.getFileContent(fileName);
    } catch {
      const results = await this.searchFiles(`class_${className.toLowerCase()}`);
      const classFile = results.find(
        (f) => f.includes('classes/') && f.includes(`class_${className.toLowerCase()}`),
      );

      if (classFile) {
        return await this.getFileContent(classFile);
      }
      throw new Error(`Class reference not found for ${className}`);
    }
  }

  async getTree(relativePath: string = ''): Promise<string[]> {
    await this.ensureDocs();
    const root = this.getDocsRoot();
    const targetPath = path.join(root, relativePath);

    if (!fs.existsSync(targetPath)) {
      throw new Error(`Path not found: ${relativePath}`);
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${relativePath}`);
    }

    const items = fs.readdirSync(targetPath);
    return items
      .filter(item => !item.startsWith('.'))
      .map(item => {
        const fullPath = path.join(targetPath, item);
        const isDir = fs.statSync(fullPath).isDirectory();
        return isDir ? `${item}/` : item;
      })
      .sort((a, b) => {
        // Sort directories first, then alphabetically
        const aIsDir = a.endsWith('/');
        const bIsDir = b.endsWith('/');
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });
  }
}
