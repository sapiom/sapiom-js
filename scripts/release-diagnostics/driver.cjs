const {spawnSync}=require('node:child_process');
const path=require('node:path');const fs=require('node:fs');
const app=path.resolve('beta-app/Sapiom.exe');
const r=spawnSync(app,[path.resolve('scripts/release-diagnostics/managed.cjs'),path.dirname(app)],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DIAG_NATIVE_NODE:process.execPath},encoding:'utf8',timeout:60000});
console.log(JSON.stringify({driverExit:r.status,error:r.error?.message,stdout:r.stdout,stderr:r.stderr}));
if(fs.existsSync('diagnostic-result.json'))console.log(fs.readFileSync('diagnostic-result.json','utf8'));
else throw Error('Diagnostic helper did not produce its marker');
process.exitCode=r.status??1;
