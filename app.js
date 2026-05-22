
const CFG = window.CLEANSATE_CONFIG || {};
const CLIENT_ID = CFG.GOOGLE_CLIENT_ID || "";
const DB_NAME = "cleanslate_v7_db";
const DB_VERSION = 1;
const SCOPE = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send"
].join(" ");

let tokenClient = null;
let accessToken = localStorage.getItem("cs_access_token") || "";
let scanPaused = false;
let scanRunning = false;
let selected = new Set();

const $ = (id)=>document.getElementById(id);
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function setStatus(id,msg){ $(id).textContent = msg || ""; }
function updateAuthUI(){
  $("authBadge").textContent = accessToken ? "Gmail connected" : "Not connected";
  $("authStatus").textContent = accessToken ? "Connected. Start or resume the full mailbox scan." : "Not connected.";
}

function initGoogle(){
  if(!CLIENT_ID || CLIENT_ID.includes("PASTE")){
    setStatus("authStatus","Missing Google Client ID in config.js");
    return;
  }
  if(!window.google || !google.accounts || !google.accounts.oauth2){
    setTimeout(initGoogle,500);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    prompt: "select_account consent",
    callback: (resp)=>{
      if(resp.error){
        setStatus("authStatus", "Google auth error: " + JSON.stringify(resp));
        return;
      }
      accessToken = resp.access_token;
      localStorage.setItem("cs_access_token", accessToken);
      updateAuthUI();
    }
  });
}

function openDb(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains("senders")) db.createObjectStore("senders",{keyPath:"key"});
      if(!db.objectStoreNames.contains("state")) db.createObjectStore("state",{keyPath:"key"});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function dbGet(store,key){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction(store,"readonly");const r=tx.objectStore(store).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
async function dbPut(store,val){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction(store,"readwrite");tx.objectStore(store).put(val);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});}
async function dbAll(store){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction(store,"readonly");const r=tx.objectStore(store).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error);});}
async function dbClearAll(){
  localStorage.removeItem("cs_scan_state");
  selected.clear();
  indexedDB.deleteDatabase(DB_NAME);
  await sleep(500);
  location.reload();
}

function authHeaders(){ return {Authorization:`Bearer ${accessToken}`}; }

async function gmailFetch(url, opts={}){
  const res = await fetch(url,{...opts,headers:{...(opts.headers||{}),...authHeaders()}});
  if(res.status===401){
    accessToken="";
    localStorage.removeItem("cs_access_token");
    updateAuthUI();
    throw new Error("Google session expired. Tap Connect Gmail again, then resume scan.");
  }
  if(!res.ok){
    const t=await res.text();
    throw new Error(`Gmail API error ${res.status}: ${t.slice(0,250)}`);
  }
  return res.json();
}

function parseEmailName(v){
  if(!v) return {name:"Unknown sender",email:""};
  const m = v.match(/"?([^"<]+)"?\s*<([^>]+)>/);
  if(m) return {name:m[1].trim().replace(/^"|"$/g,''), email:m[2].trim().toLowerCase()};
  const email = (v.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)||[""])[0].toLowerCase();
  return {name:(email ? email.split("@")[0] : v).trim(), email: email || v.trim().toLowerCase()};
}
function domainOf(email){ return (email.split("@")[1]||email).toLowerCase().replace(/^www\./,""); }
function header(headers,name){ const h=(headers||[]).find(x=>(x.name||"").toLowerCase()===name.toLowerCase()); return h ? h.value : ""; }
function extractUnsub(headers){
  const raw = header(headers,"List-Unsubscribe");
  const oneClick = header(headers,"List-Unsubscribe-Post");
  if(!raw) return {url:"", mailto:"", oneClick:!!oneClick};
  const bracketUrls = [...raw.matchAll(/<([^>]+)>/g)].map(x=>x[1]);
  const splitUrls = raw.split(",").map(x=>x.trim());
  const urls = bracketUrls.concat(splitUrls).filter(Boolean);
  const https = urls.find(u=>/^https?:\/\//i.test(u) && !/example\.com/i.test(u));
  const mailto = urls.find(u=>/^mailto:/i.test(u));
  return {url:https||"", mailto:mailto||"", oneClick:!!oneClick, raw};
}
const protectedWords = [
  "bank","credit","capital one","fidelity","mortgage","loan","insurance","geico","progressive","state farm",
  "doctor","medical","hospital","mychart","health","pharmacy","rx","medicaid","social security",
  "irs","tax","turbotax","payroll","w2","receipt","order","invoice","payment","statement","bill","utility",
  "honda","acura","regal","google","apple","amazon","walmart","target","netflix","disney","school","daycare",
  "xfinity","spectrum","t-mobile","verizon","at&t","paypal","zelle","cash app"
];
function classifySender(s){
  const txt = `${s.name} ${s.email} ${s.domain}`.toLowerCase();
  const safe = protectedWords.some(w=>txt.includes(w)) || (s.count>=15 && !s.unsubUrl && !s.unsubMailto);
  if(safe) return {bucket:"safe", label:"KEEP SAFE", score:100};
  if(s.unsubUrl || s.unsubMailto) return {bucket:"remove", label:"UNSUBSCRIBE", score:20};
  return {bucket:"manual", label:"REVIEW", score:50};
}
async function upsertSender(fromHeader, headers){
  const p = parseEmailName(fromHeader);
  const key = p.email || p.name.toLowerCase();
  const domain = domainOf(p.email||p.name);
  const unsub = extractUnsub(headers);
  let s = await dbGet("senders",key);
  if(!s) s={key,name:p.name||p.email,email:p.email,domain,count:0,lastSeen:Date.now(),unsubUrl:"",unsubMailto:"",oneClick:false};
  s.count++;
  s.lastSeen = Date.now();
  if(unsub.url) s.unsubUrl=unsub.url;
  if(unsub.mailto) s.unsubMailto=unsub.mailto;
  s.oneClick = s.oneClick || unsub.oneClick;
  const cls = classifySender(s);
  s.bucket=cls.bucket; s.label=cls.label; s.score=cls.score;
  await dbPut("senders",s);
}

async function fetchMessageMeta(id){
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`;
  return gmailFetch(url);
}

async function mapConcurrent(items, limit, fn){
  let i=0, done=0;
  const workers = Array.from({length:limit}, async ()=>{
    while(i<items.length && !scanPaused){
      const item=items[i++];
      try{ await fn(item); } catch(e){ console.warn(e); }
      done++;
      if(done % 20 === 0) await sleep(1);
    }
  });
  await Promise.all(workers);
}

async function saveScanState(st){ localStorage.setItem("cs_scan_state", JSON.stringify(st)); await dbPut("state",{key:"scan",...st}); }
function loadScanState(){ try{return JSON.parse(localStorage.getItem("cs_scan_state")||"{}")}catch{return {}} }

async function updateProgress(st){
  $("scanCount").textContent = `${st.totalScanned||0} emails scanned`;
  $("pageCount").textContent = `${st.pages||0} pages`;
  const all = await dbAll("senders");
  $("senderCount").textContent = `${all.length} senders found`;
  const pct = st.done ? 100 : Math.min(98, ((st.pages||0)%50)*2);
  $("progressFill").style.width = pct + "%";
}

async function scanFullMailbox(){
  if(scanRunning) return;
  if(!accessToken){ setStatus("scanStatus","Connect Gmail first."); return; }
  scanRunning=true; scanPaused=false;
  let st = loadScanState();
  if(!st || typeof st !== "object") st = {};
  st.totalScanned = st.totalScanned || 0;
  st.pages = st.pages || 0;
  st.nextPageToken = st.nextPageToken || "";
  st.done = false;

  try{
    while(!scanPaused){
      const tokenParam = st.nextPageToken ? `&pageToken=${encodeURIComponent(st.nextPageToken)}` : "";
      const queryParam = CFG.SCAN_QUERY ? `&q=${encodeURIComponent(CFG.SCAN_QUERY)}` : "";
      setStatus("scanStatus",`Scanning page ${st.pages+1}...\nSaved progress: ${st.totalScanned} emails`);
      const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${CFG.MAX_LIST_PAGE_SIZE||500}${queryParam}${tokenParam}`;
      const page = await gmailFetch(listUrl);
      const messages = page.messages || [];
      if(messages.length === 0){
        st.done = true;
        await saveScanState(st);
        break;
      }
      await mapConcurrent(messages, CFG.MESSAGE_FETCH_CONCURRENCY||6, async (m)=>{
        const msg = await fetchMessageMeta(m.id);
        const headers = msg.payload?.headers || [];
        const from = header(headers,"From");
        if(from) await upsertSender(from, headers);
      });
      st.totalScanned += messages.length;
      st.pages += 1;
      st.nextPageToken = page.nextPageToken || "";
      await saveScanState(st);
      await updateProgress(st);
      if(st.pages % 2 === 0) await renderSenderList(false);
      await sleep(50);
      if(!st.nextPageToken){
        st.done = true;
        await saveScanState(st);
        break;
      }
    }
    await updateProgress(st);
    await renderSenderList(true);
    setStatus("scanStatus", scanPaused ? `Paused. Saved at ${st.totalScanned} emails. Tap Start / Resume to continue.` : `Full scan finished or Gmail returned no more pages. Total scanned: ${st.totalScanned}.`);
  }catch(e){
    await saveScanState(st);
    setStatus("scanStatus",`Scan stopped safely, progress saved.\n${e.message}\nTap Connect Gmail if needed, then Start / Resume.`);
  }finally{
    scanRunning=false;
  }
}

function safeText(s){ return (s||"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c])); }

async function renderSenderList(full=true){
  const senders = await dbAll("senders");
  const sorted = senders.sort((a,b)=>{
    const order = {safe:0, remove:1, manual:2};
    return (order[a.bucket]??9)-(order[b.bucket]??9) || (b.count||0)-(a.count||0);
  });
  const list = $("senderList");
  const show = sorted.slice(0, full ? 500 : 120);
  let auto=0, manual=0;
  sorted.forEach(s=>{ if((s.unsubUrl||s.unsubMailto)&&s.bucket!=="safe") auto++; else if(s.bucket!=="safe") manual++; });
  $("autoCount").textContent = auto;
  $("manualCount").textContent = manual;
  $("selectedCount").textContent = selected.size;
  list.innerHTML = show.map(s=>{
    const canSelect = s.bucket !== "safe" && (s.unsubUrl || s.unsubMailto);
    const pillClass = s.bucket==="safe" ? "safeP" : (s.bucket==="remove" ? "badP":"warnP");
    const checked = selected.has(s.key) ? "checked" : "";
    return `<div class="senderCard ${s.bucket}">
      <input type="checkbox" data-key="${safeText(s.key)}" ${checked} ${canSelect?"":"disabled"}>
      <div>
        <div class="senderTitle">${safeText(s.name || s.email || s.domain)}</div>
        <div class="senderMeta">${safeText(s.email || s.domain)} • ${s.count||0} emails${s.unsubUrl ? " • auto link" : s.unsubMailto ? " • mail unsubscribe" : ""}</div>
      </div>
      <div class="pill ${pillClass}">${s.label || s.bucket}</div>
    </div>`;
  }).join("");
  list.querySelectorAll("input[type=checkbox]").forEach(cb=>{
    cb.addEventListener("change",()=>{
      if(cb.checked) selected.add(cb.dataset.key); else selected.delete(cb.dataset.key);
      $("selectedCount").textContent = selected.size;
    });
  });
}

async function selectAllUnsafe(){
  const senders = await dbAll("senders");
  senders.forEach(s=>{
    if(s.bucket!=="safe" && (s.unsubUrl || s.unsubMailto)) selected.add(s.key);
  });
  await renderSenderList(true);
}

async function sendMailtoUnsub(mailto){
  const url = mailto.replace(/^mailto:/i,"");
  const [toPart, qs] = url.split("?");
  const params = new URLSearchParams(qs || "");
  const to = decodeURIComponent(toPart);
  const subject = params.get("subject") || "Unsubscribe";
  const body = params.get("body") || "Please unsubscribe me from this mailing list.";
  const raw = btoa(unescape(encodeURIComponent(
    `To: ${to}\r\nSubject: ${subject}\r\n\r\n${body}`
  ))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{
    method:"POST",
    headers:{...authHeaders(),"Content-Type":"application/json"},
    body:JSON.stringify({raw})
  });
  if(!res.ok) throw new Error(await res.text());
}

async function autoUnsubscribeSelected(){
  if(!accessToken){ setStatus("unsubStatus","Connect Gmail first."); return; }
  const senders = await dbAll("senders");
  const targets = senders.filter(s=>selected.has(s.key));
  let ok=0, manual=0, fail=0;
  setStatus("unsubStatus",`Starting ${targets.length} unsubscribe attempts...`);
  for(const s of targets){
    try{
      if(s.unsubMailto){
        await sendMailtoUnsub(s.unsubMailto);
        ok++;
      }else if(s.unsubUrl){
        try{
          await fetch(s.unsubUrl, {method: s.oneClick ? "POST" : "GET", mode:"no-cors"});
          ok++;
        }catch(e){
          manual++;
          window.open(s.unsubUrl, "_blank");
        }
      }else{
        manual++;
      }
    }catch(e){
      fail++;
      if(s.unsubUrl) window.open(s.unsubUrl, "_blank");
    }
    setStatus("unsubStatus",`Processed ${ok+manual+fail}/${targets.length}\nAuto/sent: ${ok}\nNeeds manual: ${manual}\nFailed: ${fail}`);
    await sleep(250);
  }
}

$("connectBtn").addEventListener("click",()=> tokenClient ? tokenClient.requestAccessToken({prompt:"select_account consent"}) : setStatus("authStatus","Google script still loading. Try again."));
$("disconnectBtn").addEventListener("click",()=>{accessToken="";localStorage.removeItem("cs_access_token");updateAuthUI();});
$("startScanBtn").addEventListener("click",scanFullMailbox);
$("pauseScanBtn").addEventListener("click",()=>{scanPaused=true;setStatus("scanStatus","Pausing after current batch saves...");});
$("resetScanBtn").addEventListener("click",dbClearAll);
$("selectAllUnsafeBtn").addEventListener("click",selectAllUnsafe);
$("clearSelectedBtn").addEventListener("click",()=>{selected.clear();renderSenderList(true);});
$("refreshListBtn").addEventListener("click",()=>renderSenderList(true));
$("unsubscribeBtn").addEventListener("click",autoUnsubscribeSelected);

updateAuthUI();
initGoogle();
renderSenderList(false);
(async()=>{ const st=loadScanState(); if(st.totalScanned) await updateProgress(st); })();
