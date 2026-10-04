import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createPublicClient,createWalletClient,http,keccak256,toBytes,parseAbi,encodeDeployData,encodeFunctionData,type Abi,type Hex,type Address} from 'viem';
import {ARBITRUM_SEPOLIA,ARBITRUM_USDC} from '../src/chain/settlement.js';
import {RULE_LABEL} from '../src/verifier/rules.js';
import {loadRole} from './role-config.js';
const owner=loadRole('owner'),agent=loadRole('agent'),verifier=loadRole('verifier');
const p=createPublicClient({chain:ARBITRUM_SEPOLIA,transport:http()});const w=createWalletClient({chain:ARBITRUM_SEPOLIA,transport:http(),account:owner});
if(await p.getChainId()!==421614)throw new Error('Wrong chain, refusing deployment');
execFileSync('forge',['build','--root','contracts'],{stdio:'inherit'});
const sourceHash=keccak256(toBytes(readFileSync('contracts/src/AgoranomosSettlement.sol','utf8')));
const artifact=JSON.parse(readFileSync('contracts/out/AgoranomosSettlement.sol/AgoranomosSettlement.json','utf8'));
const abi=artifact.abi as Abi,erc20=parseAbi(['function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)']);
const ruleVersion=keccak256(toBytes(RULE_LABEL));
const args=[ARBITRUM_USDC,owner.address,agent.address,verifier.address,ruleVersion,86400n,1000000n,250000n];
const artifactHash=keccak256(artifact.bytecode.object as Hex);
const path='artifacts/deployment.json';mkdirSync('artifacts',{recursive:true});
const state:Record<string,any>=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{chainId:421614,token:ARBITRUM_USDC,owner:owner.address,agent:agent.address,verifier:verifier.address,payee:owner.address,ruleVersion,periodBudgetMicro:'1000000',approvalThresholdMicro:'250000',periodSeconds:86400,gasSpentWei:'0',sourceHash,artifactHash};
if(state.chainId!==421614||state.owner!==owner.address||state.agent!==agent.address||state.verifier!==verifier.address)throw new Error('Checkpoint roles/chain mismatch');
if(state.sourceHash!==sourceHash||state.artifactHash!==artifactHash)throw new Error('Checkpoint source/artifact mismatch; refusing reuse of another build');
const save=()=>{state.timestamp=new Date().toISOString();writeFileSync(path,JSON.stringify(state,null,2));};
// Entire owner execution is capped to 0.002 test ETH, including its agent gas top-up.
const cap=2000000000000000n,topup=100000000000000n;
const balance=(address:Address)=>p.readContract({address:ARBITRUM_USDC,abi:erc20,functionName:'balanceOf',args:[address]});
if(state.inflight){const receipt=await p.waitForTransactionReceipt({hash:state.inflight.hash});if(receipt.status!=='success')throw new Error('Previously broadcast step reverted');state[state.inflight.step]=state.inflight.hash;if(state.inflight.step==='deploymentTx')state.contract=receipt.contractAddress;state.gasSpentWei=String(BigInt(state.gasSpentWei)+receipt.gasUsed*receipt.effectiveGasPrice+BigInt(state.inflight.value));delete state.inflight;if(state.contract)state.deployedCodeHash=keccak256((await p.getCode({address:state.contract}))!);save();}
const existingFunds=state.contract?await balance(state.contract):0n;
const needed=existingFunds>=1000000n?0n:1000000n-existingFunds;
if(await balance(owner.address)<needed)throw new Error('Treasury needs 1 test USDC before any deployment broadcast');
const eth=await p.getBalance({address:owner.address});if(eth<topup)throw new Error('Treasury lacks test ETH for gas and agent top-up');
if(!state.contract){const deployData=encodeDeployData({abi,bytecode:artifact.bytecode.object as Hex,args});const estimate=await p.estimateGas({account:owner.address,data:deployData});const fee=await p.getGasPrice()*2n;const reserve=estimate*fee*12n/10n+topup+500000n*fee;if(reserve>cap)throw new Error('Estimated full test deployment exceeds 0.002 ETH cap');if(eth<reserve)throw new Error(`Need ${reserve} wei test ETH for deployment plus setup`);console.log('Preflight total reserve wei',String(reserve));}
if(process.env.BROADCAST_TESTNET!=='1'){console.log('Preflight complete. Explicit BROADCAST_TESTNET=1 required for testnet broadcast.');process.exit(0);}
async function step(name:string,to:Address|undefined,data:Hex,value=0n){if(state[name])return;
const estimated=await p.estimateGas({account:owner.address,to,data,value});const gas=estimated*12n/10n,gasPrice=await p.getGasPrice()*2n;
const maximum=gas*gasPrice+value;if(BigInt(state.gasSpentWei)+maximum>cap)throw new Error('Test ETH spend cap reached');if(await p.getBalance({address:owner.address})<maximum)throw new Error('Insufficient test ETH for step');
const hash=await w.sendTransaction({to,data,value,gas,gasPrice});state.inflight={step:name,hash,value:String(value)};save();
const receipt=await p.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw new Error(`${name} reverted`);state[name]=hash;if(name==='deploymentTx')state.contract=receipt.contractAddress;state.gasSpentWei=String(BigInt(state.gasSpentWei)+receipt.gasUsed*receipt.effectiveGasPrice+value);delete state.inflight;if(name==='deploymentTx')state.deployedCodeHash=keccak256((await p.getCode({address:state.contract}))!);save();}
await step('deploymentTx',undefined,encodeDeployData({abi,bytecode:artifact.bytecode.object as Hex,args}));
const contract=state.contract as Address;const deployedCode=await p.getCode({address:contract});if(!deployedCode)throw new Error('Deployed code absent');if(state.deployedCodeHash!==keccak256(deployedCode))throw new Error('Deployed bytecode differs from checkpoint');
for(const [name,want] of [['owner',owner.address],['agent',agent.address],['verifier',verifier.address],['token',ARBITRUM_USDC]] as const){const actual=await p.readContract({address:contract,abi,functionName:name});if(String(actual).toLowerCase()!==want.toLowerCase())throw new Error(`Onchain ${name} mismatch`);}
if(!await p.readContract({address:contract,abi,functionName:'allowedPayee',args:[owner.address]}))await step('allowlistTx',contract,encodeFunctionData({abi,functionName:'setPayee',args:[owner.address,true]}));
if(!await p.readContract({address:contract,abi,functionName:'allowedPayee',args:[agent.address]}))await step('secondAllowlistTx',contract,encodeFunctionData({abi,functionName:'setPayee',args:[agent.address,true]}));
const onchainRule=await p.readContract({address:contract,abi,functionName:'ruleVersion'});if(onchainRule!==ruleVersion)throw new Error('Onchain rules mismatch');
for(const [name,want] of [['periodBudget',1000000n],['escalationThreshold',250000n],['periodLength',86400n]] as const){if(BigInt(await p.readContract({address:contract,abi,functionName:name}) as bigint)!==want)throw new Error('Onchain limit mismatch');}
const funding=await balance(contract);if(funding<1000000n)await step('fundingTx',ARBITRUM_USDC,encodeFunctionData({abi:erc20,functionName:'transfer',args:[contract,1000000n-funding]}));
if(await p.getBalance({address:agent.address})<topup)await step('agentGasTx',agent.address,'0x',topup);
state.ready=true;save();console.log(JSON.stringify(state,null,2));
