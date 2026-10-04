import {readFileSync} from 'node:fs';
import {privateKeyToAccount} from 'viem/accounts';
import type {Hex} from 'viem';
/** Key files live outside the public repository and are provided explicitly. */
export function roleKey(role:'owner'|'agent'|'verifier'):Hex{
const key=role==='owner'?'DEPLOYER_PRIVATE_KEY':role==='agent'?'AGENT_PRIVATE_KEY':'VERIFIER_PRIVATE_KEY';
const configured=process.env[`${role.toUpperCase()}_ENV_FILE`];
if(!configured)throw new Error(`Set ${role.toUpperCase()}_ENV_FILE to a private role configuration file`);
const value=readFileSync(configured,'utf8').split('\n').find(l=>l.startsWith(key+'='))?.slice(key.length+1).trim();
if(!value)throw new Error(`Missing ${role} role configuration`);
return value as Hex;
}
export function loadRole(role:'owner'|'agent'|'verifier'){return privateKeyToAccount(roleKey(role));}
