const fs=require('fs');
const h=fs.readFileSync('starpivot/viewer/universe.html','utf8');
const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];
let bad=0;
m.forEach((s,i)=>{ try{ new Function(s[1]); console.log('ok',i,s[1].length);}catch(e){bad++;console.log('ERR',i,e.message);} });
process.exit(bad?1:0);
