const { chmodSync } = require('fs');
const { join } = require('path');
const { platform } = require('os');

exports.default = async function(context) {
  if (platform() !== 'darwin' && platform() !== 'linux') return;
  const appDir = context.appOutDir;
  const appName = context.packager.appInfo.productFilename;
  const resourcesDir = platform() === 'darwin'
    ? join(appDir, `${appName}.app/Contents/Resources`)
    : join(appDir, 'resources');
  const helpers = [
    join(resourcesDir, 'app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper'),
  ];
  for (const h of helpers) {
    try {
      chmodSync(h, 0o755);
      console.log(`  [fix-spawn-helper] chmod 755 ${h}`);
    } catch (e) {
      console.warn(`  [fix-spawn-helper] skipped: ${h} (${e.message})`);
    }
  }
};
