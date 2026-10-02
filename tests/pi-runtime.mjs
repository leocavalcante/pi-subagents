import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
let piRoot = process.env.PI_PACKAGE_DIR;
if (!piRoot) {
  try { piRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))); }
  catch {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    piRoot = join(globalRoot, '@earendil-works/pi-coding-agent');
  }
}
const piRequire = createRequire(join(piRoot, 'package.json'));
export const jiti = piRequire('jiti').createJiti(import.meta.url);
export const { loadExtensions } = await import(pathToFileURL(join(piRoot, 'dist/core/extensions/loader.js')));
