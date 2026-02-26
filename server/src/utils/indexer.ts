import { pipeline } from '@xenova/transformers';
import sqlite3 from 'sqlite3';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import * as sqliteVec from 'sqlite-vec';

export class CodeIndexer {
    private db: sqlite3.Database;
    private embedder: any;
    private isInitialized = false;

    constructor(private projectPath: string, private dbPath: string = ':memory:') {
        this.db = new sqlite3.Database(this.dbPath);
        // Load sqlite-vec extension
        // @ts-ignore -- sqlite-vec types don't exactly match sqlite3 Database types but it works
        sqliteVec.load(this.db);
    }

    async init() {
        if (this.isInitialized) return;

        // Initialize database tables
        this.db.serialize(() => {
            this.db.run(`
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL,
          content TEXT NOT NULL,
          type TEXT NOT NULL
        )
      `);

            this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_documents USING vec0(
          id INTEGER PRIMARY KEY,
          embedding float[384]
        )
      `);
        });

        // Initialize embedding model
        // Using a lightweight, fast model suitable for code/text
        this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

        this.isInitialized = true;
        console.log('Semantic Indexer initialized successfully.');
    }

    async generateEmbedding(text: string): Promise<Float32Array> {
        const output = await this.embedder(text, { pooling: 'mean', normalize: true });
        return output.data as Float32Array;
    }

    async indexFile(filePath: string, content: string, type: string) {
        if (!this.isInitialized) throw new Error("Indexer not initialized");

        const embedding = await this.generateEmbedding(content);

        return new Promise<void>((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                // Keep a reference to this.db for the inner callbacks
                const db = this.db;

                this.db.run(
                    `INSERT INTO documents (file_path, content, type) VALUES (?, ?, ?)`,
                    [filePath, content, type],
                    function (this: sqlite3.RunResult, err: any) {
                        if (err) return reject(err);
                        const docId = this.lastID;

                        // sqlite-vec expects raw binary buffers for float arrays
                        const buffer = Buffer.from(embedding.buffer);

                        db.run(
                            `INSERT INTO vec_documents(id, embedding) VALUES (?, ?)`,
                            [docId, buffer],
                            (vecErr: any) => {
                                if (vecErr) {
                                    db.run('ROLLBACK');
                                    return reject(vecErr);
                                }
                                db.run('COMMIT', (commitErr: any) => {
                                    if (commitErr) reject(commitErr);
                                    else resolve();
                                });
                            }
                        );
                    }
                );
            });
        });
    }

    async search(query: string, limit: number = 5): Promise<Array<{ path: string, content: string, distance: number }>> {
        if (!this.isInitialized) throw new Error("Indexer not initialized");

        const queryEmbedding = await this.generateEmbedding(query);
        const buffer = Buffer.from(queryEmbedding.buffer);

        return new Promise((resolve, reject) => {
            // Find top K most similar vectors using cosine distance
            const sql = `
        SELECT 
          d.file_path, 
          d.content,
          v.distance
        FROM vec_documents v
        JOIN documents d ON v.id = d.id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `;

            this.db.all(sql, [buffer, limit], (err, rows: any[]) => {
                if (err) reject(err);
                else resolve(rows.map(row => ({
                    path: row.file_path,
                    content: row.content,
                    distance: row.distance
                })));
            });
        });
    }

    // Structural AST-like chunker for Godot files
    private chunkFileContent(text: string, ext: string, maxTokens: number = 500): string[] {
        const chunks: string[] = [];

        if (ext === '.gd') {
            // GDScript Parsing Logic
            // Split into header (extends, class_name, signals, vars) and functions
            const lines = text.split('\n');
            let currentChunk = '';
            let inFunction = false;

            for (const line of lines) {
                // Check if line defines a new function or class
                const isFunc = line.match(/^(\s*)static\s+func\s+|^(\s*)func\s+/);
                const isClass = line.match(/^class\s+/);

                if (isFunc || isClass) {
                    if (currentChunk.trim().length > 0) {
                        chunks.push(currentChunk.trim());
                    }
                    currentChunk = line + '\n';
                    inFunction = true;
                } else {
                    currentChunk += line + '\n';

                    // Fallback to split massive functions just in case
                    if (inFunction && currentChunk.length > maxTokens * 4) {
                        chunks.push(currentChunk.trim());
                        currentChunk = '';
                    }
                }
            }
            if (currentChunk.trim().length > 0) {
                chunks.push(currentChunk.trim());
            }

        } else if (ext === '.tscn') {
            // TSCN Parsing Logic
            // Split by scene nodes and resources
            const nodeRegex = /(?=\[node\s+name=|\[ext_resource\s+|\[sub_resource\s+)/g;
            const segments = text.split(nodeRegex);

            let currentChunk = '';
            for (const segment of segments) {
                if (currentChunk.length + segment.length > maxTokens * 4) {
                    if (currentChunk.trim().length > 0) {
                        chunks.push(currentChunk.trim());
                    }
                    currentChunk = segment;
                } else {
                    currentChunk += segment;
                }
            }
            if (currentChunk.trim().length > 0) {
                chunks.push(currentChunk.trim());
            }

        } else {
            // Fallback for other files: rough approximation by double newlines
            const paragraphs = text.split('\n\n');
            let currentChunk = '';

            for (const p of paragraphs) {
                if ((currentChunk.length + p.length) > maxTokens * 4) {
                    if (currentChunk) chunks.push(currentChunk.trim());
                    currentChunk = p;
                } else {
                    currentChunk += (currentChunk ? '\n\n' : '') + p;
                }
            }
            if (currentChunk) chunks.push(currentChunk.trim());
        }

        return chunks.length > 0 ? chunks : [text];
    }

    async buildIndex() {
        if (!this.isInitialized) await this.init();
        console.log('Starting full project index build...');

        const walkSync = (dir: string, filelist: string[] = []) => {
            const files = readdirSync(dir);
            files.forEach((file) => {
                const filepath = join(dir, file);
                // Skip ignored directories
                if (file === '.godot' || file === 'addons' || file === 'node_modules' || file.startsWith('.')) return;

                if (statSync(filepath).isDirectory()) {
                    filelist = walkSync(filepath, filelist);
                } else {
                    const ext = extname(filepath);
                    if (ext === '.gd' || ext === '.tscn') {
                        filelist.push(filepath);
                    }
                }
            });
            return filelist;
        };

        const filesToIndex = walkSync(this.projectPath);
        console.log(`Found ${filesToIndex.length} files to index.`);

        let indexedChunks = 0;

        // Process sequentially to avoid blowing up memory with embeddings
        for (const file of filesToIndex) {
            const content = readFileSync(file, 'utf-8');
            const ext = extname(file);
            const relativePath = file.replace(this.projectPath, '').replace(/^[\/\\]/, '');

            const chunks = this.chunkFileContent(content, ext);

            for (const chunk of chunks) {
                await this.indexFile(relativePath, chunk, ext);
                indexedChunks++;
            }
            console.log(`Indexed ${relativePath} (${chunks.length} chunks)`);
        }

        console.log(`Indexing complete. Total chunks indexed: ${indexedChunks}`);
    }
}

// Singleton manager for the indexer
let _indexerInstance: CodeIndexer | null = null;
let _currentProjectPath: string | null = null;

export function getCodeIndexer(projectPath: string): CodeIndexer {
    if (!_indexerInstance || _currentProjectPath !== projectPath) {
        _indexerInstance = new CodeIndexer(projectPath);
        _currentProjectPath = projectPath;
    }
    return _indexerInstance;
}
