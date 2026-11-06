import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Pure authority/link tests require only JDK 17+, not an emulator or a running service.
const root = resolve(import.meta.dirname, '..');
const javaRoot = process.env.JAVA_HOME;
if (!javaRoot) throw new Error('Set JAVA_HOME to the supported JDK installation');
const suffix = process.platform === 'win32' ? '.exe' : '';
const cache = join(root, '.local', 'validation', 'android-protocol');
mkdirSync(cache, { recursive: true });
const output = mkdtempSync(join(cache, 'classes-'));
const source = join(root, 'third_party/moonlight-android/app/src/main/java/com/limelight/streamkit');
execFileSync(join(javaRoot, 'bin', `javac${suffix}`), [
  '-encoding', 'UTF-8', '--release', '17', '-d', output,
  ...['WatchLink', 'ConnectionAuthority', 'AuthorityState'].map(name => join(source, `${name}.java`)),
  join(root, 'scripts/android/ManagedProtocolTest.java'),
], { stdio: 'inherit', cwd: root });
execFileSync(join(javaRoot, 'bin', `java${suffix}`), ['-cp', output, 'ManagedProtocolTest'],
  { stdio: 'inherit', cwd: root });
