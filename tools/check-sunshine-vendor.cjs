// Check the single-repository source contract without network access.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'third_party-manifests/sunshine-dependencies.json')));
const index = execFileSync('git', ['ls-files', '--stage', '-z', '--', 'third_party/sunshine'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const tracked = new Map(index.split('\0').filter(Boolean).map(entry => {
  const tab = entry.indexOf('\t');
  return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')[0]];
}));
let checkedModes = 0;
for (const [file, mode] of tracked) {
  if (mode === '160000') throw new Error(`Submodule is not allowed: ${file}`);
}
for (const dep of lock.dependencies) {
  if (!dep.path.startsWith('third_party/sunshine/') || dep.path.split('/').includes('..')) throw new Error('Invalid dependency path');
  if (!/^[a-f0-9]{40}$/.test(dep.commit)) throw new Error(`Missing source revision: ${dep.path}`);
  const dir = path.join(root, dep.path);
  if (!fs.existsSync(dir) || fs.existsSync(path.join(dir, '.git'))) throw new Error(`Missing or nested repository: ${dep.path}`);
  if (![...tracked.keys()].some(file => file.startsWith(dep.path + '/'))) throw new Error(`Untracked source directory: ${dep.path}`);
  for (const [list, mode] of [[dep.executables, '100755'], [dep.symlinks, '120000']]) {
    for (const file of list) {
      if (tracked.get(dep.path + '/' + file) !== mode) throw new Error(`Lost source mode ${mode}: ${dep.path}/${file}`);
      checkedModes++;
    }
  }
}
for (const file of [
  'third-party/build-deps/package-lock.cmake',
  'third-party/libdisplaydevice/CMakeLists.txt',
  'third-party/libvirtualhid/CMakeLists.txt',
  'third-party/lizardbyte-common/third-party/googletest/CMakeLists.txt',
  'third-party/moonlight-common-c/enet/CMakeLists.txt',
  'third-party/Simple-Web-Server/CMakeLists.txt',
  'third-party/tray/CMakeLists.txt',
]) {
  if (!tracked.has('third_party/sunshine/' + file)) throw new Error(`Missing build input: ${file}`);
}
console.log(JSON.stringify({ dependencies: lock.dependencies.length, trackedFiles: tracked.size, preservedModes: checkedModes, submodules: 0 }));
