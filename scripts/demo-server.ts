import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const root=resolve('review-site');
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.mp4':'video/mp4','.png':'image/png','.txt':'text/plain; charset=utf-8'};
createServer(async(req,res)=>{try{const url=new URL(req.url??'/', 'http://localhost');const requested=decodeURIComponent(url.pathname);const file=resolve(root,'.'+(requested==='/'?'/index.html':requested));if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(404).end('Not found');}}).listen(Number(process.env.PORT??8788),'127.0.0.1',()=>console.log(`Public synthetic demo at http://127.0.0.1:${process.env.PORT??8788}`));
