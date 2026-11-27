import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const [original,output,signInPath]=process.argv.slice(2);
if(!original||!output)throw Error('Usage: node scripts/assemble-immersive.mjs <approved-HTML> <output-directory> [real-same-origin-sign-in-path]');
if(signInPath!==undefined&&!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(signInPath))
  throw Error('Sign-in path must be a simple same-origin path, not an external redirect.');
let source=await readFile(original,'utf8');
if(!source.includes('data-info="Pricing"')||!source.includes('id="preview-disclosure"')||
   source.includes('./billing.js')||!source.includes('</head>')||!source.includes('</body>'))
  throw Error('Unexpected immersive source; do not overwrite the original.');
// Preserve the original scene, layout and sample dashboard, but never call the demo a real login.
const previewButtons=/<button([^>]*\bdata-enter="[^"]*"[^>]*)>\s*Sign In\s*<\/button>/gi;
const sampleCount=[...source.matchAll(previewButtons)].length;
if(sampleCount!==2)throw Error('Unexpected sign-in controls; review source before publishing.');
source=source.replace(previewButtons,(_match,attrs)=>{
  if(!signInPath)return '<button'+attrs+'>Preview Dashboard</button>';
  return '<button'+attrs.replace(/\bdata-enter="[^"]*"/,'data-jusspay-sign-in="'+signInPath+'"')+'>Sign In</button>';
});
if(signInPath){
  source=source.replace(/(<span[^>]*id="preview-disclosure"[^>]*>)[^<]*/, '$1BILLING · SIGN-IN REQUIRED');
}
source=source.replace('</head>','<link rel="stylesheet" href="./billing.css"></head>')
  .replace('</body>','<script src="./billing.js" type="module"></script></body>');
await mkdir(output,{recursive:true});
await writeFile(join(output,'index.html'),source,{flag:'wx'});
await Promise.all(['billing.js','billing.css'].map(file=>copyFile(new URL('../frontend/'+file,import.meta.url),join(output,file))));
