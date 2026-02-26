import fs from 'fs';
import path from 'path';
import https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Path to store documentation
const DOCS_DIR = path.resolve(process.cwd(), 'docs_cache');
// Using Godot 4.3 docs (stable) or master? The user said "Godot 4.4" in context of UIDs.
// Using master might be best for latest features, but stable is safer.
// Reference used master.
const DOCS_URL = 'https://github.com/godotengine/godot-docs/archive/refs/heads/master.zip';

export class DocsManager {
  private static instance: DocsManager;
  private initialized = false;

  private constructor() {}

  static getInstance(): DocsManager {
    if (!DocsManager.instance) {
      DocsManager.instance = new DocsManager();
    }
    return DocsManager.instance;
  }

  async ensureDocs(): Promise<void> {
    if (this.initialized && fs.existsSync(DOCS_DIR)) return;

    if (!fs.existsSync(DOCS_DIR)) {
      console.error('[DocsManager] Downloading Godot documentation...');
      await this.downloadAndExtractDocs();
    }
    
    this.initialized = true;
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          if (response.headers.location) {
            this.downloadFile(response.headers.location, dest)
              .then(resolve)
              .catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download docs: ${response.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(dest);
        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          resolve();
        });
        
        file.on('error', (err) => {
          fs.unlink(dest, () => {});
          reject(err);
        });
      });

      request.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });
  }

  private async downloadAndExtractDocs(): Promise<void> {
    const zipPath = path.join(process.cwd(), 'godot-docs.zip');
    
    // Download
    await this.downloadFile(DOCS_URL, zipPath);

    console.error('[DocsManager] Extracting documentation...');
    
    // Extract using PowerShell (Windows) or unzip (Linux/Mac)
    try {
        if (process.platform === 'win32') {
             await execAsync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${DOCS_DIR}' -Force"`);
        } else {
             // Create dir if not exists
             if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
             await execAsync(`unzip -o "${zipPath}" -d "${DOCS_DIR}"`);
        }
    } catch (e) {
        console.error("[DocsManager] Extraction failed", e);
        throw e;
    } finally {
        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
        }
    }
  }
  
  getDocsRoot(): string {
      // Find the inner folder (godot-docs-master)
      if (!fs.existsSync(DOCS_DIR)) return DOCS_DIR;
      
      const files = fs.readdirSync(DOCS_DIR);
      // If there is only one directory, it's likely the extracted root
      if (files.length === 1 && fs.statSync(path.join(DOCS_DIR, files[0])).isDirectory()) {
          return path.join(DOCS_DIR, files[0]);
      }
      return DOCS_DIR;
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
      
      // Recursive search
      const searchDir = (dir: string) => {
          const files = fs.readdirSync(dir);
          for (const file of files) {
              const fullPath = path.join(dir, file);
              
              // Skip hidden files/dirs
              if (file.startsWith('.')) continue;

              try {
                  const stat = fs.statSync(fullPath);
                  
                  if (stat.isDirectory()) {
                      searchDir(fullPath);
                  } else if (file.toLowerCase().includes(query.toLowerCase())) {
                      results.push(path.relative(root, fullPath).replace(/\\/g, '/'));
                  }
              } catch (e) {
                  // Ignore access errors
              }
          }
      };
      
      searchDir(root);
      return results.slice(0, 50); // Limit results
  }
  
  async getClassReference(className: string): Promise<string> {
      await this.ensureDocs();
      
      // Godot docs structure: classes/class_<name>.rst
      const fileName = `classes/class_${className.toLowerCase()}.rst`;
      try {
          return await this.getFileContent(fileName);
      } catch (e) {
          // Try fuzzy search in classes directory
          const results = await this.searchFiles(`class_${className.toLowerCase()}`);
          const classFile = results.find(f => f.includes('classes/') && f.includes(`class_${className.toLowerCase()}`));
          
          if (classFile) {
              return await this.getFileContent(classFile);
          }
          throw new Error(`Class reference not found for ${className}`);
      }
  }
  
  async getDocumentationTree(): Promise<string> {
      await this.ensureDocs();
      const root = this.getDocsRoot();
      
      // Only list top level directories and key files
      const structure: string[] = [];
      
      try {
        const files = fs.readdirSync(root);
        for (const file of files) {
             if (file.startsWith('.')) continue;
             const stat = fs.statSync(path.join(root, file));
             if (stat.isDirectory()) {
                 structure.push(`/${file}/`);
                 // List a few children to give an idea
                 try {
                     const children = fs.readdirSync(path.join(root, file)).slice(0, 5);
                     children.forEach(c => structure.push(`  - ${c}`));
                     if (fs.readdirSync(path.join(root, file)).length > 5) {
                         structure.push(`  - ...`);
                     }
                 } catch (e) {}
             } else {
                 structure.push(file);
             }
        }
      } catch (e) {
          return `Error listing documentation: ${(e as Error).message}`;
      }
      
      return structure.join('\n');
  }
}
