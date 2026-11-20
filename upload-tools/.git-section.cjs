const { execSync } = require('child_process');
const src = execSync('git show bd9a1a9:src/views/browse.ts', { encoding: 'utf8' });
const lines = src.split('\n');
let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('SMB 浏览')) { start = i; break; }
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].trimStart().startsWith('// ----')) { end = i; break; }
}
console.log('SECTION ' + start + ' .. ' + (end - 1));
console.log(lines.slice(start, end).join('\n'));
