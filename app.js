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
  getDoc,
  setDoc,
  getDocs,
  collection,
  writeBatch,
  serverTimestamp,
  query,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const CFG = window.CLEANSATE_CONFIG || {};
const WORKER_URL = (CFG.WORKER_URL || "https://cleanslate-render-worker.onrender.com").replace(/\/$/, "");
const WORKER_SECRET = CFG.WORKER_SECRET || "";

let firebaseApp;
let auth;
let db;
let user = null;
let accessToken = localStorage.getItem("cs_gmail_token") || "";
let tokenClient = null;
let selected = new Set();
let scanPaused = false;
let scanRunning = false;
let senders = {};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(id, msg) {
  const el = $(id);
  if (el) el.textContent = msg || "";
}

function logButton(name) {
  setStatus("authStatus", `Clicked: ${name}\nFirebase: ${user ? user.email : "not signed in"}\nGmail access: ${accessToken ? "connected" : "not connected"}`);
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

function cleanKey(value) {
  return String(value || "unknown").toLowerCase().replace(/[.#$/\[\]]/g, "_").slice(0, 180);
}

function updateAuth() {
  setStatus(
    "authStatus",
    `App version: ${CFG.APP_VERSION || "unknown"}\nFirebase: ${user ? user.email : "not signed in"}\nGmail access: ${accessToken ? "connected" : "not connected"}`
  );
}

function showError(where, error) {
  setStatus(where, `${error?.message || error?.code || JSON.stringify(error)}`);
}

async function firebaseLogin() {
  logButton("Firebase Login");
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  try {
    await signInWithPopup(auth, provider);
  } catch (popupError) {
    setStatus("authStatus", `Popup did not complete:\n${popupError.message || popupError.code}\nTrying redirect...`);
    try {
      await signInWithRedirect(auth, provider);
    } catch (redirectError) {
      showError("authStatus", redirectError);
    }
  }
}

async function handleRedirectResult() {
  try {
    const result = await getRedirectResult(auth);
    if (result?.user) {
      setStatus("authStatus", `Firebase signed in:\n${result.user.email}`);
    }
  } catch (error) {
    showError("authStatus", error);
  }
}

function initGoogleOAuth() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(initGoogleOAuth, 500);
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.GOOGLE_CLIENT_ID,
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send"
    ].join(" "),
    prompt: "select_account consent",
    callback: (response) => {
      if (response.error) {
        setStatus("authStatus", "Gmail OAuth error: " + JSON.stringify(response));
        return;
      }
      accessToken = response.access_token;
      localStorage.setItem("cs_gmail_token", accessToken);
      updateAuth();
    }
  });
}

function authHeaders() {
  return { Authorization: `Bearer ${accessToken}` };
}

async function gmailFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeaders() }
  });

  if (response.status === 401) {
    accessToken = "";
    localStorage.removeItem("cs_gmail_token");
    updateAuth();
    throw new Error("Gmail session expired. Tap Connect Gmail Access again.");
  }

  if (!response.ok) throw new Error(`Gmail ${response.status}: ${(await response.text()).slice(0, 220)}`);
  return response.json();
}

function header(headers, name) {
  return (headers || []).find((h) => (h.name || "").toLowerCase() === name.toLowerCase())?.value || "";
}

function parseFrom(value) {
  const input = value || "";
  const match = input.match(/"?([^"<]+)"?\s*<([^>]+)>/);
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ""), email: match[2].trim().toLowerCase() };
  const email = (input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [""])[0].toLowerCase();
  return { name: email ? email.split("@")[0] : input || "Unknown", email: email || input.toLowerCase() };
}

function domainOf(email) {
  return String(email || "").split("@").pop().toLowerCase().replace(/^www\./, "");
}

function extractUnsubscribe(headers) {
  const raw = header(headers, "List-Unsubscribe");
  const oneClick = Boolean(header(headers, "List-Unsubscribe-Post"));
  const bracketUrls = [...String(raw || "").matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  const splitUrls = String(raw || "").split(",").map((x) => x.trim());
  const urls = [...bracketUrls, ...splitUrls].filter(Boolean);

  return {
    url: urls.find((u) => /^https?:\/\//i.test(u) && !/example\.com/i.test(u)) || "",
    mailto: urls.find((u) => /^mailto:/i.test(u)) || "",
    oneClick
  };
}

const protectedWords = [
  "bank", "credit", "capital one", "fidelity", "mortgage", "loan", "insurance",
  "geico", "progressive", "doctor", "medical", "hospital", "mychart", "pharmacy",
  "irs", "tax", "payroll", "w2", "receipt", "order", "invoice", "payment",
  "statement", "bill", "utility", "honda", "acura", "regal", "google", "apple",
  "amazon", "walmart", "netflix", "school", "daycare", "paypal", "zelle", "wallet"
];

function classifySender(sender) {
  const text = `${sender.name} ${sender.email} ${sender.domain}`.toLowerCase();
  if (protectedWords.some((word) => text.includes(word))) return "safe";
  if (sender.unsubUrl || sender.unsubMailto) return "cleanup";
  return "review";
}

async function upsertSender(fromHeader, headers) {
  const parsed = parseFrom(fromHeader);
  const domain = domainOf(parsed.email || parsed.name);
  const key = cleanKey(parsed.email || domain || parsed.name);
  const unsub = extractUnsubscribe(headers);

  const sender = senders[key] || {
    key,
    name: parsed.name,
    email: parsed.email,
    domain,
    count: 0,
    unsubUrl: "",
    unsubMailto: "",
    oneClick: false,
    protected: false
  };

  sender.name = parsed.name || sender.name;
  sender.email = parsed.email || sender.email;
  sender.domain = domain || sender.domain;
  sender.count = (sender.count || 0) + 1;
  if (unsub.url) sender.unsubUrl = unsub.url;
  if (unsub.mailto) sender.unsubMailto = unsub.mailto;
  sender.oneClick = sender.oneClick || unsub.oneClick;
  sender.bucket = sender.protected ? "safe" : classifySender(sender);

  senders[key] = sender;
  localStorage.setItem("cs_senders_cache", JSON.stringify(senders));
}

function loadLocalState() {
  try {
    senders = JSON.parse(localStorage.getItem("cs_senders_cache") || "{}");
  } catch {
    senders = {};
  }
}

function scanState() {
  try {
    return JSON.parse(localStorage.getItem("cs_scan_state_pro") || "{}");
  } catch {
    return {};
  }
}

async function loadScanStateFromFirebase() {
  const localState = scanState();
  if (!user) return localState;

  try {
    const snap = await getDoc(doc(db, "users", user.uid, "state", "scan"));
    if (!snap.exists()) return localState;
    const remoteState = snap.data() || {};
    const remoteTotal = Number(remoteState.total || 0);
    const localTotal = Number(localState.total || 0);

    if (remoteTotal >= localTotal) {
      const cleaned = {
        total: remoteTotal,
        pages: Number(remoteState.pages || 0),
        nextPageToken: remoteState.nextPageToken || "",
        done: Boolean(remoteState.done)
      };
      localStorage.setItem("cs_scan_state_pro", JSON.stringify(cleaned));
      return cleaned;
    }
    return localState;
  } catch (error) {
    setStatus("scanStatus", "Could not load Firebase scan state. Using local progress.\n" + (error.message || error));
    return localState;
  }
}

async function saveScanState(state) {
  localStorage.setItem("cs_scan_state_pro", JSON.stringify(state));
  if (user) {
    await setDoc(doc(db, "users", user.uid, "state", "scan"), {
      total: Number(state.total || 0),
      pages: Number(state.pages || 0),
      nextPageToken: state.nextPageToken || "",
      done: Boolean(state.done),
      updatedAt: serverTimestamp()
    }, { merge: true });
  }
}

async function loadFirebaseSenders() {
  if (!user) {
    setStatus("scanStatus", "Sign in with Firebase first.");
    return;
  }
  const snapshot = await getDocs(query(collection(db, "users", user.uid, "senders"), limit(10000)));
  snapshot.forEach((item) => {
    senders[item.id] = item.data();
  });
  renderSenders();
}

async function bulkSaveFirebase() {
  if (!user) return;
  const values = Object.values(senders);
  for (let i = 0; i < values.length; i += 450) {
    const batch = writeBatch(db);
    values.slice(i, i + 450).forEach((sender) => {
      batch.set(doc(db, "users", user.uid, "senders", sender.key), {
        ...sender,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    });
    await batch.commit();
    setStatus("scanStatus", `Saved ${Math.min(i + 450, values.length)}/${values.length} sender groups to Firebase.`);
    await sleep(75);
  }
}

async function scanMailbox() {
  logButton("Start / Resume Scan");
  if (scanRunning) {
    setStatus("scanStatus", "Scan is already running.");
    return;
  }
  if (!accessToken) {
    setStatus("scanStatus", "Connect Gmail Access first.");
    return;
  }

  scanRunning = true;
  scanPaused = false;
  let state = await loadScanStateFromFirebase();
  state.total = state.total || 0;
  state.pages = state.pages || 0;
  state.nextPageToken = state.nextPageToken || "";
  state.done = false;

  try {
    while (!scanPaused) {
      const pageToken = state.nextPageToken ? `&pageToken=${encodeURIComponent(state.nextPageToken)}` : "";
      setStatus("scanStatus", `Scanning page ${state.pages + 1}...\nSaved at ${state.total} emails.`);
      const page = await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${CFG.MAX_LIST_PAGE_SIZE || 500}${pageToken}`);
      const messages = page.messages || [];
      if (!messages.length) {
        state.done = true;
        break;
      }

      let index = 0;
      let processedThisPage = 0;
      const workers = Array.from({ length: CFG.MESSAGE_FETCH_CONCURRENCY || 6 }, async () => {
        while (!scanPaused) {
          const currentIndex = index++;
          if (currentIndex >= messages.length) break;
          const message = messages[currentIndex];

          try {
            const full = await gmailFetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`
            );
            if (scanPaused) break;
            const headers = full.payload?.headers || [];
            const from = header(headers, "From");
            if (from) await upsertSender(from, headers);
            processedThisPage += 1;
            if (processedThisPage % 25 === 0) {
              updateStats({ ...state, total: state.total + processedThisPage });
              setStatus("scanStatus", `Scanning...\nProcessed ${state.total + processedThisPage} emails.`);
              await sleep(1);
            }
          } catch (error) {
            console.warn(error);
          }
        }
      });

      await Promise.all(workers);
      state.total += processedThisPage;

      if (!scanPaused && processedThisPage >= messages.length) {
        state.pages += 1;
        state.nextPageToken = page.nextPageToken || "";
      }

      await saveScanState(state);
      updateStats(state);
      renderSenders();

      if (!scanPaused && state.pages % 2 === 0) await bulkSaveFirebase();
      if (scanPaused) break;
      if (!state.nextPageToken) {
        state.done = true;
        break;
      }
      await sleep(50);
    }

    await saveScanState(state);
    renderSenders();
    await bulkSaveFirebase();
    setStatus("scanStatus", scanPaused ? `Paused. Saved at ${state.total} emails.` : `Scan complete. ${state.total} emails scanned.`);
  } catch (error) {
    setStatus("scanStatus", `Scan stopped safely. Progress saved.\n${error.message || error}`);
    await saveScanState(state);
  }

  scanRunning = false;
}

function updateStats(state = scanState()) {
  $("emailCount").textContent = `${state.total || 0} emails`;
  $("senderCount").textContent = `${Object.keys(senders).length} senders`;
  $("pageCount").textContent = `${state.pages || 0} pages`;
  $("progressFill").style.width = state.done ? "100%" : `${Math.min(98, ((state.pages || 0) % 50) * 2)}%`;
}

function renderSenders() {
  const values = Object.values(senders).sort((a, b) => {
    const order = { safe: 0, cleanup: 1, review: 2 };
    return (order[a.bucket] ?? 9) - (order[b.bucket] ?? 9) || (b.count || 0) - (a.count || 0);
  });

  $("safeCount").textContent = values.filter((s) => s.bucket === "safe").length;
  $("unsafeCount").textContent = values.filter((s) => s.bucket !== "safe").length;
  $("selectedCount").textContent = selected.size;

  $("senderList").innerHTML = values.slice(0, CFG.RENDER_LIMIT || 400).map((sender) => {
    const selectable = sender.bucket !== "safe";
    return `<div class="sender ${sender.bucket}">
      <input type="checkbox" data-key="${escapeHtml(sender.key)}" ${selected.has(sender.key) ? "checked" : ""} ${selectable ? "" : "disabled"}>
      <div>
        <div class="title">${escapeHtml(sender.name || sender.email || sender.domain)}</div>
        <div class="meta">${escapeHtml(sender.email || sender.domain || "")} • ${sender.count || 0} emails ${sender.unsubUrl || sender.unsubMailto ? "• unsubscribe link" : ""}</div>
      </div>
      <div class="pill">${sender.bucket === "safe" ? "KEEP SAFE" : sender.bucket === "cleanup" ? "CLEANUP" : "REVIEW"}</div>
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

async function checkWorkerStatus() {
  try {
    const res = await fetch(`${WORKER_URL}/status`, { cache: "no-store" });
    const data = await res.json();
    setStatus("cleanupStatus", `Worker status:\nFirebase: ${data.hasFirebase ? "connected" : "missing"}\nGoogle OAuth: ${data.hasGoogleOAuth ? "connected" : "missing"}\nUser: ${data.hasUser ? "connected" : "missing"}`);
    return data;
  } catch (error) {
    setStatus("cleanupStatus", "Could not reach Render worker:\n" + (error.message || error));
    return null;
  }
}

async function triggerWorkerRun() {
  try {
    const headers = { "Content-Type": "application/json" };
    if (WORKER_SECRET) headers.Authorization = `Bearer ${WORKER_SECRET}`;
    const res = await fetch(`${WORKER_URL}/run-once`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "frontend" })
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      setStatus("cleanupStatus", `Worker trigger failed:\n${JSON.stringify(data, null, 2)}`);
      return;
    }
    setStatus("cleanupStatus", `Render worker triggered.\nProcessed this cycle: ${data.processed || 0}\nWorker continues polling in background while Render is awake.`);
  } catch (error) {
    setStatus("cleanupStatus", "Worker trigger error:\n" + (error.message || error));
  }
}

async function saveQueue() {
  if (!user) {
    setStatus("cleanupStatus", "Sign in with Firebase first.");
    return;
  }
  const selectedSenders = [...selected].map((key) => senders[key]).filter(Boolean);
  if (!selectedSenders.length) {
    setStatus("cleanupStatus", "No senders selected.");
    return;
  }

  for (let i = 0; i < selectedSenders.length; i += 450) {
    const batch = writeBatch(db);
    selectedSenders.slice(i, i + 450).forEach((sender) => {
      batch.set(doc(db, "users", user.uid, "cleanupQueue", sender.key), {
        ...sender,
        status: "queued",
        workerStatus: "queued",
        action: "unsubscribe_and_delete",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: "github_pages_frontend"
      }, { merge: true });
    });
    await batch.commit();
  }

  setStatus("cleanupStatus", `Saved ${selectedSenders.length} selected senders to Firebase cleanup queue.\nTriggering Render background worker...`);
  await triggerWorkerRun();
}

function exportBackup() {
  const data = {
    version: "CleanSlate Full Reset Backup",
    exportedAt: new Date().toISOString(),
    senders,
    selected: [...selected],
    scanState: scanState()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "cleanslate-backup.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

function bindButtons() {
  const bind = (id, fn) => {
    const button = $(id);
    if (!button) {
      console.warn("Missing button:", id);
      return;
    }
    button.onclick = fn;
    button.addEventListener("touchend", (event) => {
      event.preventDefault();
      fn(event);
    }, { passive: false });
  };

  bind("firebaseLoginBtn", firebaseLogin);
  bind("gmailLoginBtn", () => {
    logButton("Connect Gmail Access");
    if (!tokenClient) {
      setStatus("authStatus", "Google Gmail script is still loading. Wait 2 seconds and tap again.");
      return;
    }
    tokenClient.requestAccessToken({ prompt: "select_account consent" });
  });
  bind("logoutBtn", async () => {
    logButton("Logout");
    accessToken = "";
    localStorage.removeItem("cs_gmail_token");
    await signOut(auth);
    updateAuth();
  });
  bind("scanBtn", scanMailbox);
  bind("pauseBtn", () => {
    logButton("Pause Scan");
    scanPaused = true;
    setStatus("scanStatus", "Pause requested. Stopping as soon as active Gmail requests finish...");
  });
  bind("syncBtn", async () => {
    logButton("Sync From Firebase");
    await loadFirebaseSenders();
    const state = await loadScanStateFromFirebase();
    updateStats(state);
    setStatus("scanStatus", `Synced from Firebase. Saved at ${state.total || 0} emails.`);
  });
  bind("selectUnsafeBtn", () => {
    logButton("Select Unsafe");
    Object.values(senders).forEach((sender) => {
      if (sender.bucket !== "safe" && (sender.unsubUrl || sender.unsubMailto)) selected.add(sender.key);
    });
    renderSenders();
  });
  bind("clearBtn", () => {
    logButton("Clear Selected");
    selected.clear();
    renderSenders();
  });
  bind("saveQueueBtn", saveQueue);
  bind("unsubscribeBtn", saveQueue);
  bind("exportBtn", exportBackup);
  bind("workerStatusBtn", checkWorkerStatus);
  bind("triggerWorkerBtn", triggerWorkerRun);

  const importInput = $("importFile");
  if (importInput) {
    importInput.onchange = (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const data = JSON.parse(reader.result);
        senders = data.senders || {};
        selected = new Set(data.selected || []);
        localStorage.setItem("cs_senders_cache", JSON.stringify(senders));
        renderSenders();
        await bulkSaveFirebase();
      };
      reader.readAsText(file);
    };
  }
}

function initFirebase() {
  firebaseApp = initializeApp(CFG.FIREBASE);
  auth = getAuth(firebaseApp);
  db = getFirestore(firebaseApp);

  onAuthStateChanged(auth, async (currentUser) => {
    user = currentUser;
    if (user) {
      await setDoc(doc(db, "users", user.uid), {
        email: user.email,
        displayName: user.displayName || "",
        updatedAt: serverTimestamp()
      }, { merge: true });
      await loadFirebaseSenders();
    }
    updateAuth();
  });
}

try {
  initFirebase();
  loadLocalState();
  bindButtons();
  handleRedirectResult();
  initGoogleOAuth();
  updateAuth();
  updateStats();
  renderSenders();
  setStatus("scanStatus", `Ready. Local saved progress: ${scanState().total || 0} emails.`);
  checkWorkerStatus();
} catch (error) {
  setStatus("authStatus", "Fatal app load error:\n" + (error.message || error));
  console.error(error);
}
