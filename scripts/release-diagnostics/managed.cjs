const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
const appDir=process.argv[2];const pty=require(path.join(appDir,'resources/app/node_modules/node-pty'));
const prefix=fs.mkdtempSync(path.join(os.tmpdir(),'studio managed diagnostics '));const stub=path.join(prefix,'cli.cjs');
fs.writeFileSync(stub,`const fs=require('node:fs');fs.writeFileSync(process.env.DIAG_MARKER,JSON.stringify({reached:true,argv:process.argv,runtimeFlag:process.env.ELECTRON_RUN_AS_NODE,stdoutTTY:process.stdout.isTTY,stdinTTY:process.stdin.isTTY,stderrTTY:process.stderr.isTTY}));console.log(process.argv.includes('--version')?'99.0.0':'managed-codex-ready');console.error('managed-stderr-ready');if(process.env.DIAG_CHILD==='1'){require('node:child_process').spawnSync(process.env.DIAG_NATIVE_NODE,['-e',"require('node:fs').writeFileSync(process.env.DIAG_MARKER+'.child',JSON.stringify({stdinTTY:process.stdin.isTTY,stdoutTTY:process.stdout.isTTY,stderrTTY:process.stderr.isTTY}));console.log('managed-child-ready')"],{stdio:'inherit',env:process.env});}if(process.env.DIAG_MODE==='ack'){process.stdin.setRawMode?.(true);process.stdin.resume();process.stdin.once('data',data=>{fs.writeFileSync(process.env.DIAG_MARKER+'.input',JSON.stringify({input:data.toString()}));console.log('managed-input:'+data);process.exit(0);});}\n`);
const repair=`import fs from 'node:fs';import tty from 'node:tty';if(process.env.DIAG_REPAIR==='1'){const devices=['\\\\\\\\.\\\\CONIN$','\\\\\\\\.\\\\CONOUT$','\\\\\\\\.\\\\CONOUT$'];const observations=[];for(let fd=0;fd<3;fd++){const before={tty:tty.isatty(fd),character:fs.fstatSync(fd).isCharacterDevice()};fs.closeSync(fd);const opened=fs.openSync(devices[fd],'r+');observations.push({fd,opened,before,afterTTY:tty.isatty(opened)});if(opened!==fd)throw Error('Unexpected console fd '+opened);}fs.writeFileSync(process.env.DIAG_MARKER+'.repair',JSON.stringify(observations));}delete process.env.ELECTRON_RUN_AS_NODE;`;
// Device spelling is kept visible in the evidence before executing it.
fs.writeFileSync('diagnostic-preload.json',JSON.stringify({repair}));
const pre=['--import','data:text/javascript,'+encodeURIComponent(repair)];
const report={platform:process.platform,node:process.versions.node,electron:process.versions.electron,cases:[]};
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
async function main(){
 for(const repaired of [false,true])for(const mode of ['fast','ack'])for(const child of [false,true]){
  const file=path.join(prefix,'pty-'+repaired+'-'+mode+'-'+child+'.json');
  await new Promise(resolve=>{
   const row={repaired,mode,child,data:[],events:[]};const start=Date.now();
   const proc=pty.spawn(process.execPath,[...pre,stub,'argument with spaces','quote"&|<>^%TEST%!'],{cwd:prefix,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DIAG_REPAIR:repaired?'1':'0',DIAG_MARKER:file,DIAG_MODE:mode,DIAG_CHILD:child?'1':'0'},cols:80,rows:24});
   const timer=setTimeout(()=>{row.timeout=true;proc.kill();},5000);
   proc.onData(data=>row.data.push({ms:Date.now()-start,data}));
   const input=setTimeout(()=>{if(mode==='ack'){row.events.push({ms:Date.now()-start,type:'input'});proc.write('q');}},750);
   proc.onExit(({exitCode})=>{clearTimeout(timer);clearTimeout(input);row.exit=exitCode;row.events.push({ms:Date.now()-start,type:'exit'});for(const [key,suffix] of [['marker',''],['repair','.repair'],['childMarker','.child'],['input','.input']])row[key]=read(file+suffix);report.cases.push(row);resolve();});
  });
 }
 fs.writeFileSync('diagnostic-result.json',JSON.stringify(report,null,2));process.exit(0);
}
main().catch(err=>{report.error=err.stack;fs.writeFileSync('diagnostic-result.json',JSON.stringify(report,null,2));process.exit(1);});
