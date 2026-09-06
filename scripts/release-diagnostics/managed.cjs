const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
const appDir=process.argv[2];
const pty=require(path.join(appDir,'resources/app/node_modules/node-pty'));
const prefix=fs.mkdtempSync(path.join(os.tmpdir(),'studio managed diagnostics '));const stub=path.join(prefix,'cli.cjs');
fs.writeFileSync(stub,`const fs=require('node:fs');fs.writeFileSync(process.env.DIAG_MARKER,JSON.stringify({reached:true,argv:process.argv,runtimeFlag:process.env.ELECTRON_RUN_AS_NODE,stdoutTTY:process.stdout.isTTY,stdinTTY:process.stdin.isTTY}));console.log(process.argv.includes('--version')?'99.0.0':'managed-codex-ready');if(process.env.DIAG_MODE==='delayed')setTimeout(()=>{},1500);if(process.env.DIAG_MODE==='ack'){process.stdin.setRawMode?.(true);process.stdin.resume();process.stdin.once('data',()=>process.exit(0));}\n`);
const report={platform:process.platform,node:process.versions.node,electron:process.versions.electron,cases:[]};
function marker(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
const pre=['--import','data:text/javascript,delete%20process.env.ELECTRON_RUN_AS_NODE'];
async function main(){
 for(const imported of [false,true]){
  const file=path.join(prefix,'direct-'+imported+'.json');const args=[...(imported?pre:[]),stub,'--version'];
  const r=spawnSync(process.execPath,args,{cwd:prefix,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DIAG_MARKER:file,DIAG_MODE:'fast'},encoding:'utf8',timeout:5000,windowsHide:true});
  report.cases.push({transport:'pipe',imported,exit:r.status,error:r.error?.message,stdout:r.stdout,stderr:r.stderr,marker:marker(file)});
 }
 for(const imported of [false,true])for(const mode of ['fast','delayed','ack']){
  const file=path.join(prefix,'pty-'+imported+'-'+mode+'.json');const args=[...(imported?pre:[]),stub];
  await new Promise(resolve=>{
   const row={transport:'pty',imported,mode,data:[],events:[]};const start=Date.now();
   const proc=pty.spawn(process.execPath,args,{cwd:prefix,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DIAG_MARKER:file,DIAG_MODE:mode},cols:80,rows:24});
   const timer=setTimeout(()=>{row.timeout=true;proc.kill();},5000);
   proc.onData(data=>row.data.push({ms:Date.now()-start,data}));
   const input=setTimeout(()=>{if(mode==='ack'){row.events.push({ms:Date.now()-start,type:'input'});proc.write('q');}},1000);
   proc.onExit(({exitCode})=>{clearTimeout(timer);clearTimeout(input);row.exit=exitCode;row.events.push({ms:Date.now()-start,type:'exit'});row.marker=marker(file);report.cases.push(row);resolve();});
  });
 }
 fs.writeFileSync('diagnostic-result.json',JSON.stringify(report,null,2));
}
main().catch(err=>{report.error=err.stack;fs.writeFileSync('diagnostic-result.json',JSON.stringify(report,null,2));process.exitCode=1;});
