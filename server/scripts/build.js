/**
 * Post-build script: copies non-TypeScript assets to the dist directory.
 *
 * - godot_operations.gd → dist/scripts/godot_operations.gd
 */

import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = join(__dirname, '..');
const SRC_SCRIPTS = join(ROOT, 'src', 'scripts');
const DIST_SCRIPTS = join(ROOT, 'dist', 'scripts');

// Ensure destination exists
if (!existsSync(DIST_SCRIPTS)) {
    mkdirSync(DIST_SCRIPTS, { recursive: true });
}

// Copy GDScript operations file
const gdFile = 'godot_operations.gd';
const src = join(SRC_SCRIPTS, gdFile);
const dest = join(DIST_SCRIPTS, gdFile);

if (existsSync(src)) {
    copyFileSync(src, dest);
    console.log(`✓ Copied ${gdFile} → dist/scripts/`);
} else {
    console.warn(`⚠ ${gdFile} not found in src/scripts/ — headless operations will not work`);
}

// Copy test bridge script for E2E game testing
const bridgeFile = 'test_bridge.gd';
const bridgeSrc = join(SRC_SCRIPTS, bridgeFile);
const bridgeDest = join(DIST_SCRIPTS, bridgeFile);

if (existsSync(bridgeSrc)) {
    copyFileSync(bridgeSrc, bridgeDest);
    console.log(`✓ Copied ${bridgeFile} → dist/scripts/`);
} else {
    console.warn(`⚠ ${bridgeFile} not found in src/scripts/ — game bridge install will not work`);
}

console.log('Build post-processing complete.');
