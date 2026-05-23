import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  query,
  orderBy,
  limit,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const CFG = window.CLEANSATE_CONFIG || {};
const WORKER_URL = (CFG.WORKER_URL || "https://cleanslate-render-worker.onrender.com").replace(/\/$/, "");

const firebaseApp = initializeApp(CFG.FIREBASE);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

let user = null;
let selected = new Set();
let senders = {};

const $ = (id) => document.getElementById(id);

function setStatus(id, msg) {
  const el = $(id);
  if (el) el.textContent = msg || "";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function updateAuth() {
  setStatus("authStatus", `App: ${CFG.APP_VERSION}\nFirebase: ${user ? user.email : "not signed in"}`);
}

async function firebaseLogin() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  setStatus("authStatus", "Opening Firebase Google sign-in...");
  try {
    await signInWithPopup(auth, provider);
  } catch (popupError) {
    setStatus("authStatus", `Popup failed:\n${popupError.message || popupError.code}\nTrying redirect...`);
    await signInWithRedirect(auth, provider);
  }
}

async function handleRedirectResult() {
  try {
    await getRedirectResult(auth);
  } catch (error) {
    setStatus("authStatus", "Firebase login error:\n" + (error.message || error));
  }
}

async function workerFetch(path, options = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    cache: "no-store"
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(JSON.stringify(data, null, 2));
  return data;
}

async function checkWorker() {
  try {
    const data = await workerFetch("/status");
    $("workerState").textContent = `Worker: ${data.hasFirebase && data.hasGoogleOAuth && data.hasUser ? "ready" : "not ready"}`;
    setStatus("cleanupStatus", `Worker status:\nFirebase: ${data.hasFirebase ? "connected" : "missing"}\nGoogle OAuth: ${data.hasGoogleOAuth ? "connected" : "missing"}\nUser: ${data.hasUser ? "connected" : "missing"}\nScan active: ${data.scanActive ? "yes" : "no"}`);
    return data;
  } catch (error) {
    $("workerState").textContent = "Worker: unreachable";
    setStatus("cleanupStatus", "Worker unreachable:\n" + (error.message || error));
    return null;
  }
}

async function startServerScan() {
  setStatus("scanStatus", "Starting Render background scan...");
  try {
    const data = await workerFetch("/scan/start", { method: "POST", body: "{}" });
    setStatus("scanStatus", `Background scan started.\n${JSON.stringify(data, null, 2)}`);
    await refreshDashboard();
  } catch (error) {
    setStatus("scanStatus", "Start scan failed:\n" + (error.message || error));
  }
}

async function pauseServerScan() {
  setStatus("scanStatus", "Pausing Render background scan...");
  try {
    const data = await workerFetch("/scan/pause", { method: "POST", body: "{}" });
    setStatus("scanStatus", `Background scan pause requested.\n${JSON.stringify(data, null, 2)}`);
    await refreshDashboard();
  } catch (error) {
    setStatus("scanStatus", "Pause failed:\n" + (error.message || error));
  }
}

async function resetServerScan() {
  if (!confirm("Reset scan progress? This will restart Gmail scanning from the beginning.")) return;
  try {
    const data = await workerFetch("/scan/reset", { method: "POST", body: "{}" });
    setStatus("scanStatus", `Scan reset.\n${JSON.stringify(data, null, 2)}`);
    await refreshDashboard();
  } catch (error) {
    setStatus("scanStatus", "Reset failed:\n" + (error.message || error));
  }
}

async function loadScanState() {
  if (!user) return null;
  const snap = await getDoc(doc(db, "users", user.uid, "state", "scan"));
  const state = snap.exists() ? snap.data() : {};
  $("emailCount").textContent = `${state.total || 0} scanned`;
  $("pageCount").textContent = `${state.pages || 0} pages`;
  $("progressFill").style.width = state.done ? "100%" : `${Math.min(98, ((state.pages || 0) % 50) * 2)}%`;
  setStatus("scanStatus", `Server scan state:\nTotal scanned: ${state.total || 0}\nPages: ${state.pages || 0}\nDone: ${state.done ? "yes" : "no"}\nRunning: ${state.running ? "yes" : "no"}\nLast update: ${state.updatedAt || "none"}`);
  return state;
}

async function loadSenders() {
  if (!user) return;
  const snap = await getDocs(query(collection(db, "users", user.uid, "senders"), orderBy("count", "desc"), limit(CFG.RENDER_LIMIT || 500)));
  senders = {};
  snap.forEach((item) => {
    senders[item.id] = item.data();
  });
  renderSenders();
}

function renderSenders() {
  const vals = Object.values(senders).sort((a, b) => {
    const order = { safe: 0, cleanup: 1, review: 2 };
    return (order[a.bucket] ?? 9) - (order[b.bucket] ?? 9) || (b.count || 0) - (a.count || 0);
  });
  $("senderCount").textContent = `${vals.length} senders`;
  $("safeCount").textContent = vals.filter(s => s.bucket === "safe").length;
  $("cleanupCount").textContent = vals.filter(s => s.bucket === "cleanup").length;
  $("selectedCount").textContent = selected.size;

  $("senderList").innerHTML = vals.map((s) => {
    const canSelect = s.bucket !== "safe";
    return `<div class="sender ${s.bucket || "review"}">
      <input type="checkbox" data-key="${escapeHtml(s.key)}" ${selected.has(s.key) ? "checked" : ""} ${canSelect ? "" : "disabled"}>
      <div>
        <div class="title">${escapeHtml(s.name || s.email || s.domain)}</div>
        <div class="meta">${escapeHtml(s.email || s.domain || "")} • ${s.count || 0} emails ${s.unsubUrl || s.unsubMailto ? "• unsubscribe link" : ""}</div>
      </div>
      <div class="pill">${s.bucket === "safe" ? "KEEP SAFE" : s.bucket === "cleanup" ? "CLEANUP" : "REVIEW"}</div>
    </div>`;
  }).join("");

  document.querySelectorAll("input[data-key]").forEach((checkbox) => {
    checkbox.onchange = () => {
      if (checkbox.checked) selected.add(checkbox.dataset.key);
      else selected.delete(checkbox.dataset.key);
      $("selectedCount").textContent = selected.size;
    };
  });
}

async function saveQueue() {
  if (!user) {
    setStatus("cleanupStatus", "Sign in first.");
    return;
  }
  const targets = [...selected].map(k => senders[k]).filter(Boolean);
  if (!targets.length) {
    setStatus("cleanupStatus", "No senders selected.");
    return;
  }

  for (let i = 0; i < targets.length; i += 450) {
    const batch = writeBatch(db);
    targets.slice(i, i + 450).forEach((s) => {
      batch.set(doc(db, "users", user.uid, "cleanupQueue", s.key), {
        ...s,
        status: "queued",
        workerStatus: "queued",
        action: "unsubscribe_and_delete",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, { merge: true });
    });
    await batch.commit();
  }

  setStatus("cleanupStatus", `Queued ${targets.length} senders. Triggering worker...`);
  await triggerWorker();
}

async function triggerWorker() {
  try {
    const data = await workerFetch("/run-once", { method: "POST", body: "{}" });
    setStatus("cleanupStatus", `Worker triggered.\nProcessed: ${data.processed || 0}\nSkipped safe: ${data.skippedSafe || 0}`);
  } catch (error) {
    setStatus("cleanupStatus", "Worker trigger failed:\n" + (error.message || error));
  }
}

async function loadQueueStatus() {
  if (!user) return;
  const snap = await getDocs(query(collection(db, "users", user.uid, "cleanupQueue"), limit(1000)));
  let queued = 0, processing = 0, complete = 0, errors = 0, skipped = 0;
  snap.forEach((d) => {
    const s = d.data().workerStatus || d.data().status || "queued";
    if (s.includes("complete")) complete++;
    else if (s.includes("processing")) processing++;
    else if (s.includes("error")) errors++;
    else if (s.includes("skipped")) skipped++;
    else queued++;
  });
  setStatus("cleanupStatus", `Queue:\nQueued: ${queued}\nProcessing: ${processing}\nComplete: ${complete}\nErrors: ${errors}\nSkipped safe: ${skipped}`);
}

async function refreshDashboard() {
  await checkWorker();
  await loadScanState();
  await loadSenders();
}

function bind() {
  $("firebaseLoginBtn").onclick = firebaseLogin;
  $("logoutBtn").onclick = async () => { await signOut(auth); };
  $("startServerScanBtn").onclick = startServerScan;
  $("pauseServerScanBtn").onclick = pauseServerScan;
  $("resetServerScanBtn").onclick = resetServerScan;
  $("refreshBtn").onclick = refreshDashboard;
  $("selectCleanupBtn").onclick = () => {
    Object.values(senders).forEach((s) => { if (s.bucket === "cleanup") selected.add(s.key); });
    renderSenders();
  };
  $("clearSelectedBtn").onclick = () => { selected.clear(); renderSenders(); };
  $("saveQueueBtn").onclick = saveQueue;
  $("triggerWorkerBtn").onclick = triggerWorker;
  $("queueStatusBtn").onclick = loadQueueStatus;
}

onAuthStateChanged(auth, async (currentUser) => {
  user = currentUser;
  if (user) {
    await setDoc(doc(db, "users", user.uid), { email: user.email, updatedAt: new Date().toISOString() }, { merge: true });
  }
  updateAuth();
  await refreshDashboard();
});

try {
  bind();
  handleRedirectResult();
  updateAuth();
  checkWorker();
  setInterval(refreshDashboard, 15000);
} catch (error) {
  setStatus("authStatus", "Fatal app error:\n" + (error.message || error));
}
