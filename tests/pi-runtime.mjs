import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';

// Standalone Pi installations contain an executable, not the Node SDK.
// Use the pinned development SDK when PI_PACKAGE_DIR points to one of those.
const loaderPath = root => join(root, 'dist/core/extensions/loader.js');
let piRoot = process.env.PI_PACKAGE_DIR;
if (!piRoot || !existsSync(loaderPath(piRoot))) {
  try { piRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))); }
  catch {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    piRoot = join(globalRoot, '@earendil-works/pi-coding-agent');
  }
}
// Tests need no persistent transform cache, including Pi's own jiti loader.
process.env.JITI_FS_CACHE = 'false';
export const jiti = createJiti(import.meta.url, { fsCache: false });
export const { loadExtensions } = await import(pathToFileURL(loaderPath(piRoot)));
