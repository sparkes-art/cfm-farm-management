// build.js - stamps version on ALL JS module imports throughout the codebase
const fs = require('fs');
const path = require('path');

const version = Date.now();

function stampFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  // Strip old stamps
  content = content.replace(/(\.(js|css))\?v=\d+/g, '$1');
  // Stamp local imports: from '../../js/something.js' or src="/js/main.js"
  content = content.replace(/(from\s+['"])(\.{0,2}\/[^'"]+\.js)(['"])/g, `$1$2?v=${version}$3`);
  content = content.replace(/(import\(['"])(\.{0,2}\/[^'"]+\.js)(['"]\))/g, `$1$2?v=${version}$3`);
  content = content.replace(/(src|href)="(\/(?:js|css|modules)[^"]+\.(js|css))"/g, `$1="$2?v=${version}"`);
  fs.writeFileSync(filePath, content);
}

// Stamp index.html
stampFile(path.join(__dirname, 'index.html'));

// Stamp all JS files in js/ and modules/
function walkDir(dir) {
  fs.readdirSync(dir).forEach(file => {
    const full = path.join(dir, file);
    if (fs.statSync(full).isDirectory()) walkDir(full);
    else if (file.endsWith('.js')) stampFile(full);
  });
}

walkDir(path.join(__dirname, 'js'));
walkDir(path.join(__dirname, 'modules'));

console.log('Version stamp applied to all JS files:', version);
