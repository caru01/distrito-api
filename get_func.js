const fs = require('fs');
const content = fs.readFileSync('src/crm-service.js', 'utf8');
const match = content.match(/async function ensureContact[\s\S]*?return contact;\n\}/);
if(match) console.log(match[0]);
