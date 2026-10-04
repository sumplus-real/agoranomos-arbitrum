import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,createWalletClient,http,hashTypedData,keccak256,toBytes,BaseError,ContractFunctionRevertedError,type Abi,type Address,type Hex} from 'viem';
import {ARBITRUM_SEPOLIA,ARBITRUM_USDC,ATTESTATION_TYPES,attestationDomain,ERC20_ABI,type Attestation} from '../src/chain/settlement.js';
import {caseIdFor,type CaseRecord} from '../src/evidence/case.js';
import {signCase} from '../src/verifier/sign.js';
import {loadRole,roleKey} from './role-config.js';
const reportDir=process.env.REPORT_DIR??'artifacts';
if(process.env.LOCAL_DEMO!=='1' && process.env.BROADCAST_TESTNET!=='1')throw new Error('Explicit BROADCAST_TESTNET=1 required to execute public testnet demonstration');
const deployment=JSON.parse(readFileSync(`${reportDir}/deployment.json`,'utf8'));
const token=deployment.token as Address;
if(process.env.LOCAL_DEMO==='1' && (!process.env.RPC_URL?.startsWith('http://127.0.0.1:') || deployment.publicDeployment!==false))throw new Error('Local test mode requires loopback RPC and a local-only deployment');
if(token.toLowerCase()!==ARBITRUM_USDC.toLowerCase() && process.env.LOCAL_DEMO!=='1')throw new Error('Only canonical test USDC allowed on live network');
const abi=JSON.parse(readFileSync('contracts/out/AgoranomosSettlement.sol/AgoranomosSettlement.json','utf8')).abi as Abi;
const p=createPublicClient({chain:ARBITRUM_SEPOLIA,transport:http(process.env.RPC_URL)});
const owner=loadRole('owner'),agent=loadRole('agent'),verifier=loadRole('verifier');
const agentWallet=createWalletClient({chain:ARBITRUM_SEPOLIA,transport:http(process.env.RPC_URL),account:agent});
const ownerWallet=createWalletClient({chain:ARBITRUM_SEPOLIA,transport:http(process.env.RPC_URL),account:owner});
const contract=deployment.contract as Address;
let maximumGasReserved=0n;
async function sendContract(role:'owner'|'agent',functionName:string,args:readonly unknown[]){
 const account=role==='owner'?owner:agent,wallet=role==='owner'?ownerWallet:agentWallet;
 const estimate=await p.estimateContractGas({address:contract,abi,functionName,args,account});
 const gas=estimate*12n/10n;
 // Local EVM has an Ethereum-style priority fee default; use an explicit dummy fee there.
 // Public network fee quotation and the public spend cap remain unchanged.
 const gasPrice=process.env.LOCAL_DEMO==='1'?10000000n:await p.getGasPrice()*2n;
 const maximum=gas*gasPrice;
 if(maximumGasReserved+maximum>500000000000000n)throw new Error('Demonstration gas exceeds 0.0005 test ETH cap');
 if(await p.getBalance({address:account.address})<maximum)throw new Error('Role lacks test ETH for estimated gas');
 maximumGasReserved+=maximum;
 return wallet.writeContract({address:contract,abi,functionName,args,gas,gasPrice});
}

if(await p.getChainId()!==421614)throw new Error('Wrong chain');
const checks:{name:string;expected:string;actual:string;passed:boolean;mode:string}[]=[];
async function refuse(name:string,expected:string,a:Attestation,signature:Hex,amount:bigint,seq=0n){let actual='allowed';try{await p.simulateContract({address:contract,abi,functionName:'settle',args:[a,signature,amount,seq,keccak256(toBytes(name))],account:agent});}catch(e){if(e instanceof BaseError){const r=e.walk(x=>x instanceof ContractFunctionRevertedError);if(r instanceof ContractFunctionRevertedError)actual=r.data?.errorName??'unknown';else throw e;}else throw e;}
checks.push({name,expected,actual,passed:expected===actual,mode:'eth_call'});console.log(name,actual);}
const run=Date.now().toString();
const record:CaseRecord={caseId:caseIdFor(['synthetic-arbitrum',run]),kind:'pay_undisputed',counterparty:'synthetic:supplier',observed:[{kind:'vendor_charge',source:'synthetic-invoice',ref:`line-${run}`,jobRef:`job-${run}`,billedSeconds:10,chargedMicro:200000},{kind:'delivery_measured',source:'synthetic-measurement',ref:`clip-${run}`,jobRef:`job-${run}`,measuredSeconds:10}],contract:[],inference:[]};
const signReq={record,registry:{'synthetic:supplier':owner.address},chainId:421614,contract,token,ruleVersion:deployment.ruleVersion as Hex,ttlSeconds:3600};
const signed=await signCase(signReq,readKeyForVerifier());
function readKeyForVerifier():Hex{return roleKey('verifier');}
if(!signed.signed)throw new Error(signed.reasons.join(';'));
const {attestation:a,signature:sig}=signed.result;
const digest=hashTypedData({domain:attestationDomain(421614,contract),types:ATTESTATION_TYPES,primaryType:'Attestation',message:a});
const chainDigest=await p.readContract({address:contract,abi,functionName:'attestationDigest',args:[a]});if(digest!==chainDigest)throw new Error('EIP712 digest mismatch');
const agentSig=await agent.signTypedData({domain:attestationDomain(421614,contract),types:ATTESTATION_TYPES,primaryType:'Attestation',message:a});
await refuse('Agent self-signs','ForgedAttestation',a,agentSig,200000n);
await refuse('Changed signed payee','ForgedAttestation',{...a,payee:agent.address},sig,200000n);
await refuse('Above observed ceiling','ExceedsAttestedMaximum',a,sig,200001n);
const wrongChain=await verifier.signTypedData({domain:attestationDomain(42161,contract),types:ATTESTATION_TYPES,primaryType:'Attestation',message:a});await refuse('Wrong chain domain','ForgedAttestation',a,wrongChain,200000n);
const expired={...a,expiry:1n};const expiredSig=await verifier.signTypedData({domain:attestationDomain(421614,contract),types:ATTESTATION_TYPES,primaryType:'Attestation',message:expired});await refuse('Expired attestation','AttestationExpired',expired,expiredSig,200000n);
const balance=()=>p.readContract({address:token,abi:ERC20_ABI,functionName:'balanceOf',args:[owner.address]});
const before=await balance();
const tx=await sendContract('agent','settle',[a,sig,200000n,0n,keccak256(toBytes('synthetic measured 10s AI delivery: pay observed invoice'))]);const receipt=await p.waitForTransactionReceipt({hash:tx});if(receipt.status!=='success')throw new Error('Settlement reverted');
const after=await balance();if(after-before!==200000n)throw new Error('Real USDC balance delta differs from 0.2');
await refuse('Replay consumed intent 0','IntentAlreadyUsed',a,sig,10000n,0n);
const next=await p.readContract({address:contract,abi,functionName:'nextIntent',args:[a.caseId]});if(next!==1n)throw new Error('Wrong next intent');
const escalationRecord={...record,caseId:caseIdFor(['synthetic-escalation',run]),observed:[{...record.observed[0],chargedMicro:100000},record.observed[1]]} as CaseRecord;
const escalation=await signCase({...signReq,record:escalationRecord},readKeyForVerifier());if(!escalation.signed)throw new Error('Escalation signing refused');
const ea=escalation.result.attestation,es=escalation.result.signature;
const escalatedTx=await sendContract('agent','settle',[ea,es,100000n,0n,keccak256(toBytes('synthetic daily supplier cumulative 0.3 exceeds owner 0.25 threshold'))]);if((await p.waitForTransactionReceipt({hash:escalatedTx})).status!=='success')throw new Error('Escalation failed');
if(await balance()!==after)throw new Error('Escalation incorrectly paid before owner');
const approvalTx=await sendContract('owner','approve',[ea.caseId]);if((await p.waitForTransactionReceipt({hash:approvalTx})).status!=='success')throw new Error('Approval failed');const approvedBalance=await balance();if(approvedBalance-after!==100000n)throw new Error('Approval balance mismatch');
const report={...deployment,maximumDemoGasReservedWei:String(maximumGasReserved),fixture:'synthetic-public-fixture',settlementTx:tx,settlementBlock:String(receipt.blockNumber),settlementMicro:'200000',beforePayeeMicro:String(before),afterPayeeMicro:String(after),caseId:a.caseId,evidenceHash:a.evidenceHash,eip712Digest:digest,escalatedTx,approvalTx,approvedMicro:'100000',checks,timestamp:new Date().toISOString()};
writeFileSync(`${reportDir}/public-report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(checks.some(c=>!c.passed))throw new Error('Some negative controls failed');
