import fs from 'node:fs/promises';
import path from 'node:path';
import {projectRoot, versionFiles} from './version.mjs';
for (const [name, content] of await versionFiles()) {
  await fs.writeFile(path.join(projectRoot, name), content);
}
