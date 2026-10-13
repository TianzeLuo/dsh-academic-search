import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT_ROOT = fileURLToPath(new URL('../', import.meta.url));
let writeRoots = [PORT_ROOT];
export class PathBoundaryError extends Error {}

export function absolutePath(value) {
  const input = value instanceof URL ? fileURLToPath(value) : value;
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('Path must be a string without NUL');
  const windows = /^[A-Za-z]:[\\/]/.test(input);
  if (process.platform === 'win32' ? !windows : !input.startsWith('/') || windows) {
    throw new PathBoundaryError(`Use an absolute ${process.platform} path: ${input}`);
  }
  return path.resolve(input);
}

export function underRoot(value, root) {
  const target = absolutePath(value);
  const base = absolutePath(root);
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathBoundaryError(`Path is outside the allowed root: ${target}`);
  }
  return target;
}

function checkAncestors(value) {
  let cursor = value;
  for (;;) {
    if (fs.existsSync(absolutePath(cursor))) {
      const info = fs.lstatSync(absolutePath(cursor));
      if (info.isSymbolicLink()) throw new PathBoundaryError(`Symlink/junction paths are not supported: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (cursor === parent) break;
    cursor = parent;
  }
}

export function assertRead(value) {
  const target = absolutePath(value);
  checkAncestors(target);
  return target;
}

export function assertWrite(value) {
  const target = absolutePath(value);
  if (target === path.parse(target).root) throw new PathBoundaryError('Writing a drive/filesystem root is forbidden');
  if (process.platform === 'win32' && /^[A-Za-z]:[\\/](?:Windows|Program Files(?: \(x86\))?|ProgramData|\$Recycle\.Bin)(?:[\\/]|$)/i.test(target)) {
    throw new PathBoundaryError(`Protected Windows location: ${target}`);
  }
  if (/(?:^|[\\/])(?:\.dsh|NTUSER\.DAT)(?:[\\/]|$)/i.test(target)) throw new PathBoundaryError(`Protected account data: ${target}`);
  if (!writeRoots.some(root => {
    const relative = path.relative(absolutePath(root), target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  })) throw new PathBoundaryError(`Writing outside configured roots is forbidden: ${target}`);
  checkAncestors(target);
  return target;
}

export function setWriteRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) throw new Error('At least one write root is required');
  const resolved = roots.map(absolutePath);
  for (const root of resolved) {
    if (process.platform === 'win32' && /^[A-Za-z]:[\\/]Users(?:[\\/][^\\/]+)?$/i.test(root)) {
      throw new PathBoundaryError(`User-profile root is not an output directory: ${root}`);
    }
    if (fs.existsSync(absolutePath(path.join(root, 'NTUSER.DAT')))) throw new PathBoundaryError(`User-profile root is not an output directory: ${root}`);
  }
  const previous = writeRoots;
  writeRoots = resolved;
  try { resolved.forEach(assertWrite); } catch (error) { writeRoots = previous; throw error; }
}

export function existsSync(value) { return fs.existsSync(assertRead(value)); }
export function readFileSync(value, ...args) { return fs.readFileSync(assertRead(value), ...args); }
export function readdirSync(value, ...args) { return fs.readdirSync(assertRead(value), ...args); }
export function statSync(value, ...args) { return fs.statSync(assertRead(value), ...args); }
// Inspect a directory entry before deciding whether to traverse it. Do not follow the entry itself.
export function lstatSync(value, ...args) {
  const target = absolutePath(value);
  checkAncestors(absolutePath(path.dirname(target)));
  return fs.lstatSync(target, ...args);
}
export function mkdirSync(value, ...args) { return fs.mkdirSync(assertWrite(value), ...args); }
export function writeFileSync(value, ...args) { return fs.writeFileSync(assertWrite(value), ...args); }
