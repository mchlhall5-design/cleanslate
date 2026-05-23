import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, getDocs, collection, query, orderBy, limit, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const CFG = window.CLEANSATE_CONFIG || {};
const WORKER_URL = (CFG.WORKER_URL || "https://cleanslate-render-worker.onrender.com").replace(/\/$/, "");
const app = initializeApp(CFG.FIREBASE);
const auth = getAuth(app);
const db = getFirestore(app);
let user = null, selected = new Set(), senders = {};
const $ = id => document.getElementById(id);
const setStatus = (id,msg)=>{ const el=$(id); if(el) el.textContent=msg||""; };
const esc = v => String(v||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));

async function workerFetch(path, options={}) {
  const res = await fetch(`${WORKER_URL}${path}`, { ...options, headers: {"Content-Type":"application/json", ...(options.headers||{})}, cache:"no-store" });
  const text = await res.text();
  let data; try { data=JSON.parse(text); } catch { data={raw:text}; }
  if (!res.ok) throw new Error(JSON.stringify(data,null,2));
  return data;
}
function updateAuth(){ setStatus("authStatus", `App: ${CFG.APP_VERSION}\nFirebase: ${user ? user.email : "not signed in"}`); }
async function firebaseLogin(){
  const provider=new GoogleAuthProvider(); provider.setCustomParameters({prompt:"select_account"});
  setStatus("authStatus","Opening Firebase Google sign-in...");
  try{ await signInWithPopup(auth, provider); }catch(e){ setStatus("authStatus",`Popup failed:\n${e.message||e.code}\nTrying redirect...`); await signInWithRedirect(auth, provider); }
}
async function handleRedirectResult(){ try{ await getRedirectResult(auth); }catch(e){ setStatus("authStatus","Firebase login error:\n"+(e.message||e)); } }
function connectRenderGmail(){
  if(!user){ setStatus("gmailStatus","Sign in with Firebase first, then connect Gmail to Render."); return; }
  const returnUrl=location.href.split("#")[0].split("?")[0];
  location.href = `${WORKER_URL}/oauth/start?uid=${encodeURIComponent(user.uid)}&returnUrl=${encodeURIComponent(returnUrl)}`;
}
async function checkWorker(){
  try{
    const data=await workerFetch("/status");
    $("workerState").textContent=`Worker: ${data.hasFirebase && data.hasGoogleClient && data.hasUser ? "ready" : "not ready"}`;
    setStatus("gmailStatus",`Render worker:\nFirebase: ${data.hasFirebase?"connected":"missing"}\nGoogle OAuth Client: ${data.hasGoogleClient?"connected":"missing"}\nStored Gmail token: ${data.hasStoredGmailToken?"connected":"missing"}\nUser: ${data.hasUser?"connected":"missing"}\nScan active: ${data.scanActive?"yes":"no"}\nSpeed mode: ${data.speedMode||"unknown"}\nCallback URI: ${data.oauthCallback||""}`);
    setStatus("cleanupStatus",`Worker status:\nScan active: ${data.scanActive?"yes":"no"}\nCleanup active: ${data.cleanupActive?"yes":"no"}\nSpeed: ${data.speedMode||"unknown"}`);
    return data;
  }catch(e){ $("workerState").textContent="Worker: unreachable"; setStatus("gmailStatus","Worker unreachable:\n"+(e.message||e)); }
}
async function setSpeed(mode){
  try{
    const data = await workerFetch("/scan/speed", {method:"POST", body:JSON.stringify({mode})});
    setStatus("scanStatus", `Speed changed to ${data.speedMode}.\nConcurrency: ${data.settings.concurrency}\nDelay: ${data.settings.messageDelayMs}ms\nPages per cycle: ${data.settings.maxPagesPerCycle}`);
    await refreshDashboard();
  }catch(e){ setStatus("scanStatus","Speed change failed:\n"+(e.message||e)); }
}
async function startServerScan(){ try{ setStatus("scanStatus","Starting Render background scan..."); const d=await workerFetch("/scan/start",{method:"POST",body:JSON.stringify({continueExisting:true})}); setStatus("scanStatus",`Background scan started.\n${JSON.stringify(d,null,2)}`); await refreshDashboard(); }catch(e){ setStatus("scanStatus","Start scan failed:\n"+(e.message||e)); } }
async function pauseServerScan(){ try{ const d=await workerFetch("/scan/pause",{method:"POST",body:"{}"}); setStatus("scanStatus",`Background scan pause requested.\n${JSON.stringify(d,null,2)}`); await refreshDashboard(); }catch(e){ setStatus("scanStatus","Pause failed:\n"+(e.message||e)); } }
async function resetServerScan(){ if(!confirm("Reset scan progress?"))return; try{ const d=await workerFetch("/scan/reset",{method:"POST",body:"{}"}); setStatus("scanStatus",`Scan reset.\n${JSON.stringify(d,null,2)}`); await refreshDashboard(); }catch(e){ setStatus("scanStatus","Reset failed:\n"+(e.message||e)); } }
function fmtEta(seconds){ if(!seconds || !isFinite(seconds) || seconds < 0) return "--"; if(seconds < 60) return `${Math.round(seconds)} sec`; const m=Math.round(seconds/60); if(m<60)return `${m} min`; return `${Math.floor(m/60)}h ${m%60}m`; }
async function loadScanState(){
  if(!user)return;
  const snap=await getDoc(doc(db,"users",user.uid,"state","scan")); const s=snap.exists()?snap.data():{};
  const total = Number(s.estimatedTotal || s.messagesTotal || 0);
  const scanned = Number(s.total || 0);
  const pct = total ? Math.min(100, Math.round((scanned / total) * 1000) / 10) : 0;
  $("emailCount").textContent=`${scanned.toLocaleString()} scanned`;
  $("totalEstimate").textContent= total ? `Total: ${total.toLocaleString()}` : "Total: estimating";
  $("percentCount").textContent= total ? `${pct}%` : "estimating";
  $("progressFill").style.width = total ? `${pct}%` : `${Math.min(98, ((s.pages||0)%50)*2)}%`;
  $("pageCount").textContent=`${s.pages||0} pages`;
  $("speedDisplay").textContent=`Speed: ${s.emailsPerMinute ? Math.round(s.emailsPerMinute).toLocaleString()+"/min" : "--"}`;
  $("etaDisplay").textContent=`ETA: ${fmtEta(s.etaSeconds)}`;
  setStatus("scanStatus",`Server scan state:
Total scanned: ${scanned.toLocaleString()}
Estimated total: ${total ? total.toLocaleString() : "estimating"}
Percent: ${total ? pct+"%" : "estimating"}
Speed mode: ${s.speedMode || "not set"}
Speed: ${s.emailsPerMinute ? Math.round(s.emailsPerMinute).toLocaleString()+" emails/min" : "--"}
ETA: ${fmtEta(s.etaSeconds)}
Pages: ${s.pages||0}
Done: ${s.done?"yes":"no"}
Running: ${s.running?"yes":"no"}
Last update: ${s.updatedAt||"none"}${s.lastError ? "\n\nLast worker message:\n"+s.lastError : ""}`);
}
async function loadSenders(){
  if(!user)return;
  const snap=await getDocs(query(collection(db,"users",user.uid,"senders"), orderBy("count","desc"), limit(CFG.RENDER_LIMIT||500)));
  senders={}; snap.forEach(x=>senders[x.id]=x.data()); renderSenders();
}
function renderSenders(){
  const vals=Object.values(senders).sort((a,b)=>({safe:0,cleanup:1,review:2}[a.bucket]??9)-({safe:0,cleanup:1,review:2}[b.bucket]??9)||(b.count||0)-(a.count||0));
  $("senderCount").textContent=`${vals.length} senders`; $("safeCount").textContent=vals.filter(s=>s.bucket==="safe").length; $("cleanupCount").textContent=vals.filter(s=>s.bucket==="cleanup").length; $("selectedCount").textContent=selected.size;
  $("senderList").innerHTML=vals.map(s=>`<div class="sender ${s.bucket||"review"}"><input type="checkbox" data-key="${esc(s.key)}" ${selected.has(s.key)?"checked":""} ${s.bucket!=="safe"?"":"disabled"}><div><div class="title">${esc(s.name||s.email||s.domain)}</div><div class="meta">${esc(s.email||s.domain||"")} • ${s.count||0} emails ${s.unsubUrl||s.unsubMailto?"• unsubscribe link":""}</div></div><div class="pill">${s.bucket==="safe"?"KEEP SAFE":s.bucket==="cleanup"?"CLEANUP":"REVIEW"}</div></div>`).join("");
  document.querySelectorAll("input[data-key]").forEach(cb=>cb.onchange=()=>{ cb.checked?selected.add(cb.dataset.key):selected.delete(cb.dataset.key); $("selectedCount").textContent=selected.size; });
}
async function saveQueue(){
  if(!user)return setStatus("cleanupStatus","Sign in first.");
  const targets=[...selected].map(k=>senders[k]).filter(Boolean);
  if(!targets.length)return setStatus("cleanupStatus","No senders selected.");
  for(let i=0;i<targets.length;i+=450){ const batch=writeBatch(db); targets.slice(i,i+450).forEach(s=>batch.set(doc(db,"users",user.uid,"cleanupQueue",s.key),{...s,status:"queued",workerStatus:"queued",action:"unsubscribe_and_delete",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},{merge:true})); await batch.commit(); }
  setStatus("cleanupStatus",`Queued ${targets.length} senders. Triggering worker...`); await triggerWorker();
}
async function triggerWorker(){ try{ const d=await workerFetch("/run-once",{method:"POST",body:"{}"}); setStatus("cleanupStatus",`Worker triggered.\nProcessed: ${d.processed||0}\nSkipped safe: ${d.skippedSafe||0}`);}catch(e){setStatus("cleanupStatus","Worker trigger failed:\n"+(e.message||e));}}
async function loadQueueStatus(){ if(!user)return; const snap=await getDocs(query(collection(db,"users",user.uid,"cleanupQueue"), limit(1000))); let q=0,p=0,c=0,er=0,sk=0; snap.forEach(d=>{const s=d.data().workerStatus||d.data().status||"queued"; if(s.includes("complete"))c++; else if(s.includes("processing"))p++; else if(s.includes("error"))er++; else if(s.includes("skipped"))sk++; else q++;}); setStatus("cleanupStatus",`Queue:\nQueued: ${q}\nProcessing: ${p}\nComplete: ${c}\nErrors: ${er}\nSkipped safe: ${sk}`);}
async function refreshDashboard(){ await checkWorker(); await loadScanState(); await loadSenders(); }
function bind(){
 $("firebaseLoginBtn").onclick=firebaseLogin; $("logoutBtn").onclick=()=>signOut(auth); $("connectRenderGmailBtn").onclick=connectRenderGmail; $("checkWorkerBtn").onclick=checkWorker;
 $("startServerScanBtn").onclick=startServerScan; $("pauseServerScanBtn").onclick=pauseServerScan; $("resetServerScanBtn").onclick=resetServerScan; $("refreshBtn").onclick=refreshDashboard;
 $("speedSafeBtn").onclick=()=>setSpeed("safe"); $("speedFastBtn").onclick=()=>setSpeed("fast"); $("speedMaxBtn").onclick=()=>setSpeed("max");
 $("selectCleanupBtn").onclick=()=>{Object.values(senders).forEach(s=>{if(s.bucket==="cleanup")selected.add(s.key)});renderSenders();}; $("clearSelectedBtn").onclick=()=>{selected.clear();renderSenders();};
 $("saveQueueBtn").onclick=saveQueue; $("triggerWorkerBtn").onclick=triggerWorker; $("queueStatusBtn").onclick=loadQueueStatus;
}
onAuthStateChanged(auth, async u=>{ user=u; if(user) await setDoc(doc(db,"users",user.uid),{email:user.email,updatedAt:new Date().toISOString()},{merge:true}); updateAuth(); await refreshDashboard(); });
bind(); handleRedirectResult(); updateAuth(); checkWorker(); setInterval(refreshDashboard,10000);
