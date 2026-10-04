import {readFileSync} from 'node:fs';
import {privateKeyToAccount} from 'viem/accounts';
import {createPublicClient,http,formatEther,parseAbi,type Hex} from 'viem';
import {ARBITRUM_SEPOLIA, ARBITRUM_USDC} from '../src/chain/settlement.js';
import {loadRole} from './role-config.js';
const c=createPublicClient({chain:ARBITRUM_SEPOLIA,transport:http()});
console.log('chain',await c.getChainId(),'USDC code bytes',((await c.getCode({address:ARBITRUM_USDC}))?.length??2)/2-1);
for(const role of ['owner','agent','verifier'] as const){
const a=loadRole(role);
console.log(JSON.stringify({role,address:a.address,eth:formatEther(await c.getBalance({address:a.address})),usdcMicro:String(await c.readContract({address:ARBITRUM_USDC,abi:parseAbi(['function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)']),functionName:'balanceOf',args:[a.address]}))}));
}
