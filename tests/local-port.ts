import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const sentinel=createServer();let touched=0;sentinel.on('connection',socket=>{touched++;socket.end();});
await new Promise<void>((resolve,reject)=>{sentinel.once('error',reject);sentinel.listen(18545,'127.0.0.1',resolve);});
try{const child=spawn(process.execPath,['--import','tsx','scripts/local-e2e.ts'],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=String(chunk));child.stderr.on('data',chunk=>output+=String(chunk));const code=await new Promise<number|null>(resolve=>child.on('exit',resolve));assert.notEqual(code,0);assert.match(output,/already in use; refusing to touch/);assert.equal(touched,0,'must not connect to or mutate the existing service');assert.equal(sentinel.listening,true,'must not terminate the existing service');console.log('1 local-runner collision guard passed: existing service untouched');}finally{await new Promise<void>(resolve=>sentinel.close(()=>resolve()));}
