/** Public deterministic test keys and a mock token. This is a local EVM, never a public deployment. */
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicClient,createWalletClient,http,toHex,keccak256,toBytes,parseEther,type Abi,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {ARBITRUM_SEPOLIA} from '../src/chain/settlement.js';
import {RULE_LABEL} from '../src/verifier/rules.js';
const rpc='http://127.0.0.1:18545';
// Abort if the port belongs to an existing service. Never connect to and mutate it.
await new Promise<void>((resolve,reject)=>{const probe=createServer();probe.once('error',()=>reject(new Error('Local demonstration port 18545 is already in use; refusing to touch the existing service')));probe.listen(18545,'127.0.0.1',()=>probe.close(()=>resolve()));});
const anvil=spawn('anvil',['--host','127.0.0.1','--port','18545','--chain-id','421614','--gas-price','10000000','--base-fee','10000000'],{stdio:['ignore','pipe','pipe']});
const started=new Promise<void>((resolve,reject)=>{let output='',errors='';const timeout=setTimeout(()=>reject(new Error('Own Anvil process did not report readiness')),10000);anvil.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('Listening on 127.0.0.1:18545')){clearTimeout(timeout);resolve();}});anvil.stderr.on('data',chunk=>{errors+=String(chunk);});anvil.once('error',()=>{clearTimeout(timeout);reject(new Error('Could not start own Anvil process'));});anvil.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Own Anvil process exited before readiness (${code}); ${errors.slice(0,200)}`));});});
const dir=mkdtempSync(join(tmpdir(),'sumplus-public-test-roles-'));
try{
await started;
if(anvil.exitCode!==null)throw new Error('Own Anvil process has exited');
const accounts=[1n,2n,3n].map(n=>privateKeyToAccount(toHex(n,{size:32})));
const [owner,agent,verifier]=accounts;
const p=createPublicClient({chain:ARBITRUM_SEPOLIA,transport:http(rpc)});
if(await p.getChainId()!==421614)throw new Error('Own local chain ID does not match 421614');
if(anvil.exitCode!==null)throw new Error('Own Anvil process exited; refusing mutation');
for(const a of accounts)await p.request({method:'anvil_setBalance' as any,params:[a.address,toHex(parseEther('10'))] as any});
const wallet=createWalletClient({chain:ARBITRUM_SEPOLIA,transport:http(rpc),account:owner});
const artifact=JSON.parse(readFileSync('contracts/out/AgoranomosSettlement.sol/AgoranomosSettlement.json','utf8'));
const mock=JSON.parse(readFileSync('contracts/out/AgoranomosSettlement.t.sol/MockUSDC.json','utf8'));
const tokenTx=await wallet.deployContract({abi:mock.abi as Abi,bytecode:mock.bytecode.object as Hex});const tokenReceipt=await p.waitForTransactionReceipt({hash:tokenTx});const token=tokenReceipt.contractAddress!;
const ruleVersion=keccak256(toBytes(RULE_LABEL));
const deployTx=await wallet.deployContract({abi:artifact.abi as Abi,bytecode:artifact.bytecode.object as Hex,args:[token,owner.address,agent.address,verifier.address,ruleVersion,86400n,1000000n,250000n]});const contract=(await p.waitForTransactionReceipt({hash:deployTx})).contractAddress!;
for(const address of [owner.address,agent.address]){const tx=await wallet.writeContract({address:contract,abi:artifact.abi,functionName:'setPayee',args:[address,true]});await p.waitForTransactionReceipt({hash:tx});}
const mint=await wallet.writeContract({address:token,abi:mock.abi,functionName:'mint',args:[contract,1000000n]});await p.waitForTransactionReceipt({hash:mint});
mkdirSync('artifacts/local',{recursive:true});writeFileSync('artifacts/local/deployment.json',JSON.stringify({network:'local-anvil',publicDeployment:false,tokenType:'mock-ERC20-6-decimal',chainId:421614,token,contract,owner:owner.address,agent:agent.address,verifier:verifier.address,payee:owner.address,ruleVersion,deploymentTx:deployTx,periodBudgetMicro:'1000000',approvalThresholdMicro:'250000',periodSeconds:86400},null,2));
const env:NodeJS.ProcessEnv={...process.env,RPC_URL:rpc,LOCAL_DEMO:'1',REPORT_DIR:'artifacts/local'};
for(const [i,role,key] of [[0,'OWNER','DEPLOYER_PRIVATE_KEY'],[1,'AGENT','AGENT_PRIVATE_KEY'],[2,'VERIFIER','VERIFIER_PRIVATE_KEY']] as const){const file=join(dir,role+'.env');writeFileSync(file,`${key}=${toHex(BigInt(i+1),{size:32})}\n`,{mode:0o600});env[`${role}_ENV_FILE`]=file;}
const child=spawn(process.execPath,['--import','tsx','scripts/live-e2e.ts'],{env,stdio:'inherit'});const code=await new Promise<number|null>(r=>child.on('exit',r));if(code!==0)throw new Error('Local end-to-end failed');
}finally{anvil.kill();rmSync(dir,{recursive:true,force:true});}
