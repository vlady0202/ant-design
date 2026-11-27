// Crypto Bot 24/7: one pass of the trading engine, run by GitHub Actions every 30 minutes.
// It reuses the engine sections of ../index.html (marked //@@ENGINE-START ... //@@ENGINE-END),
// so the server trades with exactly the same strategies, lab and risk rules as the app.
//
// Env: STATE_FILE (default ../../bot-data/state.json), SETTINGS_FILE (default next to it),
//      CB_MOCK (optional path to a module exporting a fetch replacement, for tests).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createKraken, syncBroker } from './kraken.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const parts = [...html.matchAll(/\/\/@@ENGINE-START\n([\s\S]*?)\/\/@@ENGINE-END/g)].map(m => m[1]);
if (parts.length < 4) throw new Error('No engine sections found in index.html');

const STATE_FILE = process.env.STATE_FILE || path.join(here, '..', '..', 'bot-data', 'state.json');
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(path.dirname(STATE_FILE), 'settings.json');
const fetchImpl = process.env.CB_MOCK ? (await import(path.resolve(process.env.CB_MOCK))).default : fetch;

const store = {};
let fresh = true;
try { store['cryptobot.v1'] = fs.readFileSync(STATE_FILE, 'utf8'); fresh = false; } catch {}
let settings = null;
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}

const prelude = `
const localStorage={getItem:k=>__store[k]??null,setItem:(k,v)=>{__store[k]=String(v)},removeItem:k=>{delete __store[k]}};
const document={querySelector:()=>null,querySelectorAll:()=>[]};
const Live={state:'off',last:0,set(){},connect(){}};
function liveChannels(){return[]}function chartLines(){}function liveUI(){}function render(){}function toast(){}
function log(m){S.log.unshift({t:now(),m:'[24/7] '+m});if(S.log.length>150)S.log.length=150}
function fire(a,px){a.done=1;a.firedAt=now();a.firedPx=px;log('Alerta: '+a.sym+' '+(a.type==='signal'?'señal de entrada':(a.type==='above'?'subió a ':'bajó a ')+a.price))}
`;

const main = `
(async()=>{
  const cfg=__settings;
  if(__fresh)S.set.auto=true;
  S.server=Object.assign({runs:0,cmdT:0},S.server||{});
  if(cfg&&cfg.set){const keep={sym:S.set.sym,tf:S.set.tf,ind:S.set.ind};Object.assign(S.set,cfg.set,keep)}
  const cmds=((cfg&&cfg.cmds)||[]).filter(c=>c.t>S.server.cmdT).sort((a,b)=>a.t-b.t);
  for(const c of cmds){
    try{
      if(c.type==='close'){const p=S.positions.find(x=>x.id===c.id);if(p){const px=await livePrice(p.sym);closePart(S,p,p.qty*(c.f||1)+((c.f||1)>=1?1e-12:0),px,'Manual',now())}}
      else if(c.type==='be'){const p=S.positions.find(x=>x.id===c.id);if(p){p.sl=p.entry*(1+(p.dir||1)*2*S.set.fee/100);log('Stop de '+p.sym+' movido a breakeven')}}
      else if(c.type==='cancel'){S.orders=S.orders.filter(o=>o.id!==c.id)}
      else if(c.type==='delal'){S.alerts=S.alerts.filter(a=>a.id!==c.id)}
      else if(c.type==='alert'){S.alerts.push({id:uid(),sym:c.sym,type:c.atype,price:c.price||null,t:now(),done:0});if(c.atype!=='signal')S.chk[c.sym]=Math.max(S.chk[c.sym]||0,fmin(now())-60000)}
      else if(c.type==='lab'){S.lab=null}
      else if(c.type==='reset'){const keep={set:S.set,congress:S.congress,server:S.server};S=Object.assign(DEF(),keep);log('Cuenta reiniciada a $1,000')}
      else if(c.type==='order'){
        const k=await klines(c.sym,'1h',100),atr=atrF(k).pop(),plan={sl:c.sl,atr,trail:S.set.trail,tp1c:c.tp1c,tp2c:c.tp2c,dir:c.dir};
        if(c.otype==='limit'){const z=sizing(S,c.sym,c.price,c.sl,EQ());
          if(z.ok){S.orders.push({id:uid(),sym:c.sym,price:c.price,qty:z.qty,plan,t:now(),src:'Manual'});S.chk[c.sym]=Math.max(S.chk[c.sym]||0,fmin(now())-60000);log('Orden límite '+(c.dir<0?'en corto':'de compra')+': '+c.sym+' a '+fp(c.price))}
          else log('Orden de '+c.sym+' rechazada: '+z.r[0])}
        else{const px=await livePrice(c.sym);
          if(c.dir*(px-c.sl)<=0)log('Orden de '+c.sym+' rechazada: el stop quedó del lado equivocado del precio ('+fp(px)+')');
          else{const z=sizing(S,c.sym,px,c.sl,EQ());if(z.ok)openPos(S,c.sym,px,z.qty,plan,now(),fmin(now())+1,'Manual');else log('Orden de '+c.sym+' rechazada: '+z.r[0])}}
      }
    }catch(e){log('Orden '+c.type+' fallida: '+e.message)}
    S.server.cmdT=c.t;
  }
  await tick();
  if(!S.lab||now()-S.lab.t>3*864e5)await runLab(true);
  await botScan(true);
  S.server.runs++;S.server.lastRun=now();S.server.err='';
  save();
})().then(()=>__done(null),e=>{try{S.server=Object.assign(S.server||{},{lastRun:now(),err:String(e&&e.message||e)});save()}catch(_){}__done(e)});
`;

let resolveDone;
const done = new Promise(r => { resolveDone = r; });
const ctx = vm.createContext({
  __store: store, __settings: settings, __fresh: fresh, __done: e => resolveDone(e),
  fetch: fetchImpl, setTimeout, clearTimeout, console, URL, AbortController, TextEncoder, TextDecoder,
});
vm.runInContext(prelude + parts.join('\n') + main, ctx, { filename: 'crypto-bot-engine.js' });
const err = await done;

// Broker mirror (Kraken Futures demo). Runs after the engine pass, outside the sandbox, with keys from env only.
if (store['cryptobot.v1']) {
  const st0 = JSON.parse(store['cryptobot.v1']);
  const key = process.env.KRAKEN_DEMO_KEY, secret = process.env.KRAKEN_DEMO_SECRET;
  const K = key && secret ? createKraken({ key, secret, base: process.env.KRAKEN_BASE || undefined, fetchImpl }) : null;
  await syncBroker(st0, settings && settings.cmds, K);
  store['cryptobot.v1'] = JSON.stringify(st0);
}

if (store['cryptobot.v1']) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, store['cryptobot.v1']);
}
const st = JSON.parse(store['cryptobot.v1'] || '{}');
const eq = (st.cash || 0) + (st.positions || []).reduce((t, p) => t + p.qty * p.entry, 0);
console.log(`Pasada ${st.server?.runs ?? '?'} · capital aprox. $${eq.toFixed(2)} · posiciones ${(st.positions || []).length} · operaciones cerradas ${(st.history || []).length}`);
for (const l of (st.log || []).slice(0, 5)) console.log(' -', new Date(l.t).toISOString(), l.m);
if (st.broker && st.broker.err) console.log('Kraken:', st.broker.err);
if (err) { console.error('Error:', err); process.exit(1); }
