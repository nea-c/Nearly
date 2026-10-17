import {checkVersions, displayVersion} from './version.mjs';
console.log(`Version metadata verified: ${displayVersion(await checkVersions())}`);
