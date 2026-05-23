
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, writeBatch, serverTimestamp, query, limit } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const CFG = window.CLEANSATE_CONFIG;
const app = initializeApp(CFG.FIREBASE);
const auth = getAuth(app);
const db = getFirestore(app);

let user = null;
let accessToken = localStorage.getItem("cs_gmail_token") || "";
let tokenClient = null;
let selected = new Set();
let scanPaused = false;
let scanRunning = false;
let senders = {};

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function setStatus(id,msg){ const el=$(id); if(el) el.textContent = msg || ""; }
function uid(){ return user?.uid || "local"; }
function cleanKey(v){ return (v||"unknown").toLowerCase().replace(/[.#$/\\[\\]]/g,"_").slice(0,180); }

async function saveUserDoc(){
  if(!user) return;
  await setDoc(doc(db,"users",user.uid),{
    email:user.email,
    displayName:user.displayName || "",
    updatedAt:serverTimestamp()
  },{merge:true});
}
function updateAuth(){
  $("authStatus").textContent = `Firebase: ${user ? user.email : "not signed in"}\nGmail token: ${accessToken ? "connected" : "not connected"}`;
}

async function firebaseLogin(){
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({prompt:"select_account"});
  setStatus("authStatus","Opening Firebase Google sign-in...");
  try {
    // Mobile browsers often block or ignore popups, so redirect is more reliable.
    await signInWithRedirect(auth, provider);
  } catch(e){
    setStatus("authStatus","Firebase login error: " + (e.message || JSON.stringify(e)));
  }
}

onAuthStateChanged(auth, async u=>{
  user = u;
  if(user){ await saveUserDoc(); await loadFirebaseSenders(); }
  updateAuth();
});

getRedirectResult(auth).catch(()=>{});

function initGoogle(){
  if(!window.google?.accounts?.oauth2){ setTimeout(initGoogle,500); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.GOOGLE_CLIENT_ID,
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send"
    ].join(" "),
    prompt:"select_account consent",
    callback: resp=>{
      if(resp.error){ setStatus("authStatus","Gmail OAuth error: "+JSON.stringify(resp)); return; }
      accessToken = resp.access_token;
      localStorage.setItem("cs_gmail_token", accessToken);
      updateAuth();
    }
  });
}
initGoogle();

function authHeaders(){ return {Authorization:`Bearer ${accessToken}`}; }
async function gmailFetch(url, opts={}){
  const res = await fetch(url,{...opts,headers:{...(opts.headers||{}),...authHeaders()}});
  if(res.status===401){ accessToken=""; localStorage.removeItem("cs_gmail_token"); updateAuth(); throw new Error("Gmail session expired. Connect Gmail again.");}
  if(!res.ok){ throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0,220)}`);}
  return res.json();
}
function header(headers,name){ return (headers||[]).find(h=>(h.name||"").toLowerCase()===name.toLowerCase())?.value || ""; }
function parseFrom(v){
  const m=(v||"").match(/"?([^"<]+)"?\s*<([^>]+)>/);
  if(m) return {name:m[1].trim().replace(/^"|"$/g,""), email:m[2].trim().toLowerCase()};
  const email=((v||"").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i)||[""])[0].toLowerCase();
  return {name: email ? email.split("@")[0] : (v||"Unknown"), email: email || (v||"").toLowerCase()};
}
function domainOf(email){ return (email.split("@")[1]||email).toLowerCase().replace(/^www\\./,""); }
function extractUnsub(headers){
  const raw=header(headers,"List-Unsubscribe");
  const one=!!header(headers,"List-Unsubscribe-Post");
  const urls=[...[...(raw||"").matchAll(/<([^>]+)>/g)].map(x=>x[1]), ...(raw||"").split(",").map(x=>x.trim())].filter(Boolean);
  return {
    url: urls.find(u=>/^https?:\/\//i.test(u) && !/example\\.com/i.test(u)) || "",
    mailto: urls.find(u=>/^mailto:/i.test(u)) || "",
    oneClick: one
  };
}
const protectedWords = ["bank","credit","capital one","fidelity","mortgage","loan","insurance","geico","progressive","doctor","medical","hospital","mychart","pharmacy","irs","tax","payroll","w2","receipt","order","invoice","payment","statement","bill","utility","honda","acura","regal","google","apple","amazon","walmart","netflix","school","daycare","paypal","zelle","wallet"];
function classify(s){
  const txt=`${s.name} ${s.email} ${s.domain}`.toLowerCase();
  if(protectedWords.some(w=>txt.includes(w))) return "safe";
  if(s.unsubUrl || s.unsubMailto) return "cleanup";
  return "review";
}
async function upsertSender(from, headers){
  const p=parseFrom(from), domain=domainOf(p.email||p.name), key=cleanKey(p.email||domain||p.name), unsub=extractUnsub(headers);
  const old=senders[key] || {key,name:p.name,email:p.email,domain,count:0,unsubUrl:"",unsubMailto:"",oneClick:false,protected:false};
  old.name=p.name||old.name; old.email=p.email||old.email; old.domain=domain||old.domain; old.count=(old.count||0)+1;
  if(unsub.url) old.unsubUrl=unsub.url;
  if(unsub.mailto) old.unsubMailto=unsub.mailto;
  old.oneClick = old.oneClick || unsub.oneClick;
  old.bucket = old.protected ? "safe" : classify(old);
  senders[key]=old;
  localStorage.setItem("cs_senders_cache", JSON.stringify(senders));
}
async function saveSenderToFirebase(s){
  if(!user) return;
  await setDoc(doc(db,"users",user.uid,"senders",s.key), {...s, updatedAt:serverTimestamp()}, {merge:true});
}
async function bulkSaveFirebase(){
  if(!user) return;
  const vals=Object.values(senders);
  for(let i=0;i<vals.length;i+=450){
    const batch=writeBatch(db);
    vals.slice(i,i+450).forEach(s=>batch.set(doc(db,"users",user.uid,"senders",s.key), {...s, updatedAt:new Date().toISOString()}, {merge:true}));
    await batch.commit();
    setStatus("scanStatus",`Saved ${Math.min(i+450, vals.length)}/${vals.length} sender groups to Firebase.`);
    await sleep(100);
  }
}
async function loadFirebaseSenders(){
  if(!user) return;
  const snap=await getDocs(query(collection(db,"users",user.uid,"senders"), limit(10000)));
  snap.forEach(d=>{ senders[d.id]=d.data(); });
  renderSenders();
}
function loadLocalState(){
  try{ senders = JSON.parse(localStorage.getItem("cs_senders_cache")||"{}"); }catch{senders={};}
}
loadLocalState();

function scanState(){ try{return JSON.parse(localStorage.getItem("cs_scan_state_pro")||"{}")}catch{return {}}}
function saveScanState(st){ localStorage.setItem("cs_scan_state_pro", JSON.stringify(st)); if(user) setDoc(doc(db,"users",user.uid,"state","scan"), {...st, updatedAt:serverTimestamp()},{merge:true});}
async function scan(){
  if(scanRunning) return;
  if(!accessToken){ setStatus("scanStatus","Connect Gmail first."); return; }
  scanRunning=true; scanPaused=false;
  let st=scanState(); st.total=st.total||0; st.pages=st.pages||0; st.nextPageToken=st.nextPageToken||""; st.done=false;
  try{
    while(!scanPaused){
      const pt=st.nextPageToken ? `&pageToken=${encodeURIComponent(st.nextPageToken)}` : "";
      const page=await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${CFG.MAX_LIST_PAGE_SIZE||500}${pt}`);
      const msgs=page.messages||[];
      if(!msgs.length){ st.done=true; break; }
      let i=0;
      const workers=Array.from({length:CFG.MESSAGE_FETCH_CONCURRENCY||8}, async()=>{
        while(i<msgs.length && !scanPaused){
          const m=msgs[i++];
          try{
            const msg=await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`);
            const headers=msg.payload?.headers||[];
            const from=header(headers,"From");
            if(from) await upsertSender(from, headers);
          }catch(e){ console.warn(e); }
        }
      });
      await Promise.all(workers);
      st.total += msgs.length; st.pages += 1; st.nextPageToken = page.nextPageToken || "";
      saveScanState(st);
      updateStats(st);
      if(st.pages % 2 === 0) { renderSenders(); await bulkSaveFirebase(); }
      if(!st.nextPageToken){ st.done=true; break; }
      await sleep(50);
    }
    saveScanState(st);
    renderSenders(); await bulkSaveFirebase();
    setStatus("scanStatus", scanPaused ? `Paused. Saved at ${st.total} emails.` : `Scan complete. ${st.total} emails scanned.`);
  }catch(e){ setStatus("scanStatus",`Scan stopped safely. Progress saved.\\n${e.message}`); saveScanState(st); }
  scanRunning=false;
}
function updateStats(st=scanState()){
  $("emailCount").textContent = `${st.total||0} emails`;
  $("senderCount").textContent = `${Object.keys(senders).length} senders`;
  $("pageCount").textContent = `${st.pages||0} pages`;
  $("progressFill").style.width = st.done ? "100%" : `${Math.min(98, ((st.pages||0)%50)*2)}%`;
}
function renderSenders(){
  const vals=Object.values(senders).sort((a,b)=>{
    const o={safe:0,cleanup:1,review:2}; return (o[a.bucket]??9)-(o[b.bucket]??9) || (b.count||0)-(a.count||0);
  });
  $("safeCount").textContent = vals.filter(s=>s.bucket==="safe").length;
  $("unsafeCount").textContent = vals.filter(s=>s.bucket!=="safe").length;
  $("selectedCount").textContent = selected.size;
  $("senderList").innerHTML = vals.slice(0, CFG.RENDER_LIMIT||500).map(s=>{
    const selectable=s.bucket!=="safe";
    return `<div class="sender ${s.bucket}">
      <input type="checkbox" data-key="${s.key}" ${selected.has(s.key)?"checked":""} ${selectable?"":"disabled"}>
      <div><div class="title">${escapeHtml(s.name||s.email||s.domain)}</div><div class="meta">${escapeHtml(s.email||s.domain||"")} • ${s.count||0} emails ${s.unsubUrl||s.unsubMailto?"• unsubscribe link":""}</div></div>
      <div class="pill">${s.bucket==="safe"?"KEEP SAFE":s.bucket==="cleanup"?"CLEANUP":"REVIEW"}</div>
    </div>`;
  }).join("");
  document.querySelectorAll("input[data-key]").forEach(cb=>cb.onchange=()=>{ cb.checked?selected.add(cb.dataset.key):selected.delete(cb.dataset.key); $("selectedCount").textContent=selected.size; });
}
function escapeHtml(s){
  return String(s || "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;",
    "<":"&lt;",
    ">":"&gt;",
    '"':"&quot;",
    "'":"&#039;"
  }[ch]));
}
async function saveQueue(){
  if(!user){ setStatus("cleanupStatus","Sign in with Firebase first."); return; }
  const arr=[...selected].map(k=>senders[k]).filter(Boolean);
  for(let i=0;i<arr.length;i+=450){
    const batch=writeBatch(db);
    arr.slice(i,i+450).forEach(s=>batch.set(doc(db,"users",user.uid,"cleanupQueue",s.key), {...s,status:"queued",updatedAt:new Date().toISOString()}, {merge:true}));
    await batch.commit();
  }
  setStatus("cleanupStatus",`Saved ${arr.length} selected senders to Firebase cleanup queue.`);
}
function queryForSender(s){ if(s.email) return `from:${s.email}`; if(s.domain) return `from:${s.domain}`; return ""; }
async function listIds(q, token=""){ const pt=token?`&pageToken=${encodeURIComponent(token)}`:""; return gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=${encodeURIComponent(q)}${pt}`);}
async function batchModify(ids, add=[], remove=[]){
  for(let i=0;i<ids.length;i+=1000){
    const part=ids.slice(i,i+1000);
    const res=await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",{method:"POST",headers:{...authHeaders(),"Content-Type":"application/json"},body:JSON.stringify({ids:part, addLabelIds:add, removeLabelIds:remove})});
    if(!res.ok) throw new Error(await res.text());
    await sleep(80);
  }
}
async function runCleanup(action){
  if(!accessToken){ setStatus("cleanupStatus","Connect Gmail first."); return; }
  const targets=[...selected].map(k=>senders[k]).filter(s=>s && s.bucket!=="safe");
  let total=0, done=0;
  for(const s of targets){
    let token="";
    while(true){
      const page=await listIds(queryForSender(s), token);
      const ids=(page.messages||[]).map(m=>m.id);
      if(ids.length){
        if(action==="archive") await batchModify(ids,[],["INBOX"]);
        else await batchModify(ids,["TRASH"],[]);
        total+=ids.length;
      }
      token=page.nextPageToken||"";
      setStatus("cleanupStatus",`${action==="archive"?"Archived":"Moved to Trash"} ${total} emails.\\nSender ${done+1}/${targets.length}: ${s.name}`);
      if(!token) break;
    }
    done++;
    if(user) await setDoc(doc(db,"users",user.uid,"cleanupHistory",s.key), {...s, action, processedAt:new Date().toISOString(), emailsProcessed:total},{merge:true});
  }
  setStatus("cleanupStatus",`Cleanup complete. ${action==="archive"?"Archived":"Moved to Trash"} ${total} emails from ${targets.length} senders.`);
}
async function sendMailto(mailto){
  const url=mailto.replace(/^mailto:/i,""); const [toPart,qs]=url.split("?"); const params=new URLSearchParams(qs||"");
  const raw=btoa(unescape(encodeURIComponent(`To: ${decodeURIComponent(toPart)}\\r\\nSubject: ${params.get("subject")||"Unsubscribe"}\\r\\n\\r\\n${params.get("body")||"Please unsubscribe me."}`))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
  const res=await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{method:"POST",headers:{...authHeaders(),"Content-Type":"application/json"},body:JSON.stringify({raw})});
  if(!res.ok) throw new Error(await res.text());
}
async function unsubscribeQueue(){
  if(!accessToken){ setStatus("unsubStatus","Connect Gmail first."); return; }
  const targets=[...selected].map(k=>senders[k]).filter(s=>s && s.bucket!=="safe");
  let complete=0, queued=0, manual=0, errors=0;
  for(const s of targets){
    let status="manual";
    try{
      if(s.unsubMailto){ await sendMailto(s.unsubMailto); status="completed_mailto"; complete++; }
      else if(s.unsubUrl){ try{ await fetch(s.unsubUrl,{method:s.oneClick?"POST":"GET",mode:"no-cors",cache:"no-store"}); status="submitted_unverified"; complete++; }catch{ status="backend_needed"; queued++; } }
      else { manual++; }
    }catch(e){ errors++; status="api_error"; }
    if(user) await setDoc(doc(db,"users",user.uid,"unsubscribeHistory",s.key), {...s,status,processedAt:new Date().toISOString()},{merge:true});
    setStatus("unsubStatus",`Processed ${complete+queued+manual+errors}/${targets.length}\\nCompleted/submitted: ${complete}\\nQueued backend/manual: ${queued+manual}\\nAPI errors: ${errors}`);
  }
}

function exportBackup(){
  const data={version:"CleanSlate Pro Backup", exportedAt:new Date().toISOString(), senders, selected:[...selected], scanState:scanState()};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="cleanslate-backup.json"; a.click(); URL.revokeObjectURL(url);
}
function importBackup(file){
  const r=new FileReader(); r.onload=()=>{ const data=JSON.parse(r.result); senders=data.senders||{}; selected=new Set(data.selected||[]); localStorage.setItem("cs_senders_cache",JSON.stringify(senders)); renderSenders(); bulkSaveFirebase();}; r.readAsText(file);
}

$("firebaseLoginBtn").onclick=firebaseLogin;
$("gmailLoginBtn").onclick=()=> tokenClient?.requestAccessToken({prompt:"select_account consent"});
$("logoutBtn").onclick=async()=>{ accessToken=""; localStorage.removeItem("cs_gmail_token"); await signOut(auth); updateAuth(); };
$("scanBtn").onclick=scan;
$("pauseBtn").onclick=()=>{ scanPaused=true; setStatus("scanStatus","Pausing after current batch..."); };
$("syncBtn").onclick=loadFirebaseSenders;
$("selectUnsafeBtn").onclick=()=>{ Object.values(senders).forEach(s=>{ if(s.bucket!=="safe" && (s.unsubUrl||s.unsubMailto)) selected.add(s.key); }); renderSenders(); };
$("clearBtn").onclick=()=>{ selected.clear(); renderSenders(); };
$("saveQueueBtn").onclick=saveQueue;
$("exportBtn").onclick=exportBackup;
$("importFile").onchange=e=>{ if(e.target.files[0]) importBackup(e.target.files[0]); };
$("deleteBtn").onclick=()=>runCleanup("trash");
$("archiveBtn").onclick=()=>runCleanup("archive");
$("resumeCleanupBtn").onclick=()=>runCleanup("trash");
$("unsubscribeBtn").onclick=unsubscribeQueue;

setStatus("authStatus","App loaded. Tap Firebase Google sign-in.");
updateAuth(); updateStats(); renderSenders();
