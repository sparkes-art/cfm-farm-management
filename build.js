// build.js - stamps version on JS module imports to bust CDN cache on every deploy
// IMPORTANT: Only processes js/ and modules/ folders - NOT netlify/functions/
const fs = require('fs');
const path = require('path');

const version = Date.now();

function stampFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  // Strip old stamps
  content = content.replace(/(\.(js|css))\?v=\d+/g, '$1');
  // Only stamp actual ES module import/export from statements
  content = content.replace(/(from\s+['"])(\.{1,2}\/[^'"]+\.js)(['"]\s*;?)/g, `$1$2?v=${version}$3`);
  content = content.replace(/(import\(\s*['"])(\.{1,2}\/[^'"]+\.js)(['"]\s*\))/g, `$1$2?v=${version}$3`);
  // HTML src/href
  content = content.replace(/(src|href)="(\/(?:js|css|modules)[^"]+\.(js|css))"/g, `$1="$2?v=${version}"`);
  fs.writeFileSync(filePath, content);
}

function walkDir(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(file => {
    const full = path.join(dir, file);
    if (fs.statSync(full).isDirectory()) walkDir(full);
    else if (file.endsWith('.js')) stampFile(full);
  });
}

// Only stamp frontend files - never touch netlify/functions
stampFile(path.join(__dirname, 'index.html'));
walkDir(path.join(__dirname, 'js'));
walkDir(path.join(__dirname, 'modules'));
// Do NOT walk netlify/functions

console.log('Version stamp applied:', version);