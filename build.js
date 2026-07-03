// build.js - stamps version on JS module imports to bust CDN cache on every deploy
const fs = require('fs');
const path = require('path');

const version = Date.now();

function stampFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  // Strip old stamps
  content = content.replace(/(\.(js|css))\?v=\d+/g, '$1');
  // Only stamp actual ES module import/export statements and HTML src/href tags
  // NOT string literals that happen to contain .js
  content = content.replace(/((?:^|\n)\s*(?:import|export)[^'"]*['"])(\.{1,2}\/[^'"]+\.js)(['"]\s*;?)/gm, `$1$2?v=${version}$3`);
  content = content.replace(/((?:^|\n)\s*(?:import|export)[^'"]*['"])(\.{1,2}\/[^'"]+\.js)(['"]\))/gm, `$1$2?v=${version}$3`);
  content = content.replace(/(src|href)="(\/(?:js|css|modules)[^"]+\.(js|css))"/g, `$1="$2?v=${version}"`);
  fs.writeFileSync(filePath, content);
}

function walkDir(dir) {
  fs.readdirSync(dir).forEach(file => {
    const full = path.join(dir, file);
    if (fs.statSync(full).isDirectory()) walkDir(full);
    else if (file.endsWith('.js')) stampFile(full);
  });
}

stampFile(path.join(__dirname, 'index.html'));
walkDir(path.join(__dirname, 'js'));
walkDir(path.join(__dirname, 'modules'));

console.log('Version stamp applied to all JS files:', version);
