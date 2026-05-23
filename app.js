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
  getDocs,
  collection,
  writeBatch,
  serverTimestamp,
  query,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const CFG = window.CLEANSATE_CONFIG || {};
const firebaseApp = initializeApp(CFG.FIREBASE);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

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

function showMainError(error) {
  const message = error?.message || error?.code || JSON.stringify(error);
  setStatus("authStatus", `Firebase login error:\n${message}\n\nAuth domain: ${CFG.FIREBASE?.authDomain || "missing"}\nProject: ${CFG.FIREBASE?.projectId || "missing"}`);
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
    `Firebase: ${user ? user.email : "not signed in"}\nGmail access: ${accessToken ? "connected" : "not connected"}`
  );
}

async function firebaseLogin() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  setStatus("authStatus", "Opening Firebase Google sign-in...");

  try {
    await signInWithPopup(auth, provider);
  } catch (popupError) {
    setStatus("authStatus", `Popup login did not complete:\n${popupError.message || popupError.code}\n\nTrying redirect login...`);
    try {
      await signInWithRedirect(auth, provider);
    } catch (redirectError) {
      showMainError(redirectError);
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
    showMainError(error);
  }
}

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

async function loadFirebaseSenders() {
  if (!user) return;
  const snapshot = await getDocs(query(collection(db, "users", user.uid, "senders"), limit(10000)));
  snapshot.forEach((item) => {
    senders[item.id] = item.data();
  });
  renderSenders();
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

function saveScanState(state) {
  localStorage.setItem("cs_scan_state_pro", JSON.stringify(state));
  if (user) {
    setDoc(doc(db, "users", user.uid, "state", "scan"), {
      ...state,
      updatedAt: serverTimestamp()
    }, { merge: true });
  }
}

async function scanMailbox() {
  if (scanRunning) return;
  if (!accessToken) {
    setStatus("scanStatus", "Connect Gmail Access first.");
    return;
  }

  scanRunning = true;
  scanPaused = false;

  let state = scanState();
  state.total = state.total || 0;
  state.pages = state.pages || 0;
  state.nextPageToken = state.nextPageToken || "";
  state.done = false;

  try {
    while (!scanPaused) {
      const pageToken = state.nextPageToken ? `&pageToken=${encodeURIComponent(state.nextPageToken)}` : "";
      const page = await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${CFG.MAX_LIST_PAGE_SIZE || 500}${pageToken}`);
      const messages = page.messages || [];

      if (!messages.length) {
        state.done = true;
        break;
      }

      let index = 0;
      const workers = Array.from({ length: CFG.MESSAGE_FETCH_CONCURRENCY || 6 }, async () => {
        while (index < messages.length && !scanPaused) {
          const message = messages[index++];
          try {
            const full = await gmailFetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`
            );
            const headers = full.payload?.headers || [];
            const from = header(headers, "From");
            if (from) await upsertSender(from, headers);
          } catch (error) {
            console.warn(error);
          }
        }
      });

      await Promise.all(workers);

      state.total += messages.length;
      state.pages += 1;
      state.nextPageToken = page.nextPageToken || "";

      saveScanState(state);
      updateStats(state);

      if (state.pages % 2 === 0) {
        renderSenders();
        await bulkSaveFirebase();
      }

      if (!state.nextPageToken) {
        state.done = true;
        break;
      }

      await sleep(50);
    }

    saveScanState(state);
    renderSenders();
    await bulkSaveFirebase();

    setStatus("scanStatus", scanPaused ? `Paused. Saved at ${state.total} emails.` : `Scan complete. ${state.total} emails scanned.`);
  } catch (error) {
    setStatus("scanStatus", `Scan stopped safely. Progress saved.\n${error.message || error}`);
    saveScanState(state);
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

async function saveQueue() {
  if (!user) {
    setStatus("cleanupStatus", "Sign in with Firebase first.");
    return;
  }

  const selectedSenders = [...selected].map((key) => senders[key]).filter(Boolean);

  for (let i = 0; i < selectedSenders.length; i += 450) {
    const batch = writeBatch(db);
    selectedSenders.slice(i, i + 450).forEach((sender) => {
      batch.set(doc(db, "users", user.uid, "cleanupQueue", sender.key), {
        ...sender,
        status: "queued",
        updatedAt: new Date().toISOString()
      }, { merge: true });
    });
    await batch.commit();
  }

  setStatus("cleanupStatus", `Saved ${selectedSenders.length} selected senders to Firebase cleanup queue.`);
}

function queryForSender(sender) {
  if (sender.email) return `from:${sender.email}`;
  if (sender.domain) return `from:${sender.domain}`;
  return "";
}

async function listIds(queryText, token = "") {
  const pageToken = token ? `&pageToken=${encodeURIComponent(token)}` : "";
  return gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=${encodeURIComponent(queryText)}${pageToken}`);
}

async function batchModify(ids, add = [], remove = []) {
  for (let i = 0; i < ids.length; i += 1000) {
    const part = ids.slice(i, i + 1000);
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ids: part, addLabelIds: add, removeLabelIds: remove })
    });

    if (!response.ok) throw new Error(await response.text());
    await sleep(80);
  }
}

async function runCleanup(action) {
  if (!accessToken) {
    setStatus("cleanupStatus", "Connect Gmail Access first.");
    return;
  }

  const targets = [...selected].map((key) => senders[key]).filter((s) => s && s.bucket !== "safe");
  let total = 0;
  let done = 0;

  for (const sender of targets) {
    let token = "";

    while (true) {
      const page = await listIds(queryForSender(sender), token);
      const ids = (page.messages || []).map((m) => m.id);

      if (ids.length) {
        if (action === "archive") await batchModify(ids, [], ["INBOX"]);
        else await batchModify(ids, ["TRASH"], []);
        total += ids.length;
      }

      token = page.nextPageToken || "";
      setStatus("cleanupStatus", `${action === "archive" ? "Archived" : "Moved to Trash"} ${total} emails.\nSender ${done + 1}/${targets.length}: ${sender.name}`);

      if (!token) break;
    }

    done++;

    if (user) {
      await setDoc(doc(db, "users", user.uid, "cleanupHistory", sender.key), {
        ...sender,
        action,
        processedAt: new Date().toISOString()
      }, { merge: true });
    }
  }

  setStatus("cleanupStatus", `Cleanup complete. ${action === "archive" ? "Archived" : "Moved to Trash"} ${total} emails from ${targets.length} senders.`);
}

async function sendMailto(mailto) {
  const url = mailto.replace(/^mailto:/i, "");
  const [toPart, queryString] = url.split("?");
  const params = new URLSearchParams(queryString || "");
  const raw = btoa(unescape(encodeURIComponent(
    `To: ${decodeURIComponent(toPart)}\r\nSubject: ${params.get("subject") || "Unsubscribe"}\r\n\r\n${params.get("body") || "Please unsubscribe me."}`
  ))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ raw })
  });

  if (!response.ok) throw new Error(await response.text());
}

async function unsubscribeQueue() {
  if (!accessToken) {
    setStatus("unsubStatus", "Connect Gmail Access first.");
    return;
  }

  const targets = [...selected].map((key) => senders[key]).filter((s) => s && s.bucket !== "safe");
  let complete = 0;
  let queued = 0;
  let manual = 0;
  let errors = 0;

  for (const sender of targets) {
    let status = "manual";

    try {
      if (sender.unsubMailto) {
        await sendMailto(sender.unsubMailto);
        status = "completed_mailto";
        complete++;
      } else if (sender.unsubUrl) {
        try {
          await fetch(sender.unsubUrl, { method: sender.oneClick ? "POST" : "GET", mode: "no-cors", cache: "no-store" });
          status = "submitted_unverified";
          complete++;
        } catch {
          status = "backend_needed";
          queued++;
        }
      } else {
        manual++;
      }
    } catch {
      errors++;
      status = "api_error";
    }

    if (user) {
      await setDoc(doc(db, "users", user.uid, "unsubscribeHistory", sender.key), {
        ...sender,
        status,
        processedAt: new Date().toISOString()
      }, { merge: true });
    }

    setStatus("unsubStatus", `Processed ${complete + queued + manual + errors}/${targets.length}\nCompleted/submitted: ${complete}\nQueued backend/manual: ${queued + manual}\nAPI errors: ${errors}`);
  }
}

function exportBackup() {
  const data = {
    version: "CleanSlate GitHub Pages Backup",
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

function importBackup(file) {
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
}

function bindButtons() {
  const bind = (id, fn) => {
    const button = $(id);
    if (button) button.onclick = fn;
  };

  bind("firebaseLoginBtn", firebaseLogin);
  bind("gmailLoginBtn", () => {
    if (!tokenClient) {
      setStatus("authStatus", "Google Gmail script is still loading. Wait 2 seconds and tap again.");
      return;
    }
    tokenClient.requestAccessToken({ prompt: "select_account consent" });
  });
  bind("logoutBtn", async () => {
    accessToken = "";
    localStorage.removeItem("cs_gmail_token");
    await signOut(auth);
    updateAuth();
  });
  bind("scanBtn", scanMailbox);
  bind("pauseBtn", () => {
    scanPaused = true;
    setStatus("scanStatus", "Pausing after current batch...");
  });
  bind("syncBtn", loadFirebaseSenders);
  bind("selectUnsafeBtn", () => {
    Object.values(senders).forEach((sender) => {
      if (sender.bucket !== "safe" && (sender.unsubUrl || sender.unsubMailto)) selected.add(sender.key);
    });
    renderSenders();
  });
  bind("clearBtn", () => {
    selected.clear();
    renderSenders();
  });
  bind("saveQueueBtn", saveQueue);
  bind("exportBtn", exportBackup);
  bind("deleteBtn", () => runCleanup("trash"));
  bind("archiveBtn", () => runCleanup("archive"));
  bind("resumeCleanupBtn", () => runCleanup("trash"));
  bind("unsubscribeBtn", unsubscribeQueue);

  const importInput = $("importFile");
  if (importInput) {
    importInput.onchange = (event) => {
      if (event.target.files[0]) importBackup(event.target.files[0]);
    };
  }
}

loadLocalState();
bindButtons();
handleRedirectResult();
initGoogleOAuth();
updateAuth();
updateStats();
renderSenders();
setStatus("scanStatus", "Ready.");
