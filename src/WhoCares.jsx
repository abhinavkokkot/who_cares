import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Search, QrCode, Trophy, Settings, LogOut, User, Camera, Shield,
  Sparkles, Skull, Zap, Crown, Ghost, Flame, Dices, ChevronRight,
  Volume2, VolumeX, X, Check, AlertTriangle, Eye, EyeOff, ScanFace,
  RefreshCw, Gavel, Lock
} from "lucide-react";

/* ============================================================
   WHO_CARES? — a deliberately useless human-evaluation platform
   Persistence: window.storage (shared = a real shared "database"
   across every person who opens this artifact).
   Auth: SHA-256 password hashing via SubtleCrypto (real crypto,
   simplified vs. bcrypt since this runs client-side with no server).
   Coin toss: crypto.getRandomValues, computed once and persisted
   immediately — the client never gets to see-then-decide.
   ============================================================ */

const DB_USERS = "hr_users_v1";
const DB_RATINGS = "hr_ratings_v1";
const DB_REPORTS = "hr_reports_v1";
const DB_ENCOUNTERS = "hr_encounters_v1";
const DB_CATEGORIES = "hr_categories_v1";
const SESSION_KEY = "hr_session_v1";
const SOUND_KEY = "hr_sound_v1";

const CATEGORY_DEFAULTS = [
  { key: "aura", label: "Aura", emoji: "✨" },
  { key: "npc", label: "NPC Energy", emoji: "🤖" },
  { key: "mc", label: "Main Character Energy", emoji: "🎬" },
  { key: "brain", label: "Brain.exe Stability", emoji: "🧠" },
  { key: "talk", label: "Unnecessary Talking", emoji: "🗣️" },
  { key: "food", label: "Food Sharing Probability", emoji: "🍟" },
  { key: "reply", label: "Reply Speed", emoji: "📱" },
  { key: "drama", label: "Drama Generation", emoji: "🎭" },
  { key: "redflag", label: "Red Flag Density", emoji: "🚩" },
  { key: "zombie", label: "Would Survive Zombie Apocalypse", emoji: "🧟" },
  { key: "trust", label: "Wi-Fi Password Trustworthiness", emoji: "📶" },
  { key: "decision", label: "Ability To Make A Normal Decision", emoji: "🎯" },
];

const TIERS = [
  { key: "S", label: "S-TIER", min: 9.0, color: "#FFC72C", glow: "rgba(255,199,44,.35)" },
  { key: "A", label: "A-TIER", min: 7.5, color: "#3DDC97", glow: "rgba(61,220,151,.3)" },
  { key: "B", label: "B-TIER", min: 6.0, color: "#4DA3FF", glow: "rgba(77,163,255,.3)" },
  { key: "C", label: "C-TIER", min: 4.5, color: "#B98CFF", glow: "rgba(185,140,255,.3)" },
  { key: "D", label: "D-TIER", min: 3.0, color: "#FF9F4D", glow: "rgba(255,159,77,.3)" },
  { key: "E", label: "E-TIER", min: 0, color: "#FF4D3D", glow: "rgba(255,77,61,.35)" },
];
const MIN_REVIEWS_FOR_TIER = 5;

/* ---------------- storage helpers ---------------- */
async function dbGet(key, shared) {
  try {
    const r = await window.storage.get(key, shared);
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}
async function dbSet(key, value, shared) {
  try {
    await window.storage.set(key, JSON.stringify(value), shared);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- crypto helpers ---------------- */
async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function secureCoinToss() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % 2 === 0 ? "HEADS" : "TAILS";
}
function humanCode(id) {
  // deterministic short "encounter code" derived from the user's id
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return "HR-" + h.toString(36).toUpperCase().slice(0, 6).padStart(6, "0");
}

/* ---------------- scoring / tiers ---------------- */
function computeStats(userId, ratings, categories) {
  const mine = ratings.filter((r) => r.targetId === userId && !r.deleted);
  const count = mine.length;
  if (count === 0) return { count: 0, score: 0, tier: "UNRANKED", breakdown: {} };
  const breakdown = {};
  categories.forEach((c) => (breakdown[c.key] = { sum: 0, n: 0 }));
  let totalSum = 0, totalN = 0;
  mine.forEach((r) => {
    Object.entries(r.categories || {}).forEach(([k, v]) => {
      if (!breakdown[k]) breakdown[k] = { sum: 0, n: 0 };
      breakdown[k].sum += v;
      breakdown[k].n += 1;
      totalSum += v;
      totalN += 1;
    });
  });
  const rawAvg = totalN ? totalSum / totalN : 0;
  // Bayesian-ish confidence shrinkage toward global baseline (5.5) so a
  // single 10/10 rating can't instantly launch someone to S-TIER.
  const GLOBAL_BASELINE = 5.5;
  const CONF = 5;
  const score = (count / (count + CONF)) * rawAvg + (CONF / (count + CONF)) * GLOBAL_BASELINE;
  const catAverages = {};
  Object.entries(breakdown).forEach(([k, v]) => {
    catAverages[k] = v.n ? v.sum / v.n : null;
  });
  let tier = "UNRANKED";
  if (count >= MIN_REVIEWS_FOR_TIER) {
    tier = TIERS.find((t) => score >= t.min)?.key || "E";
  }
  return { count, score: Math.round(score * 10) / 10, tier, breakdown: catAverages };
}
function tierMeta(key) {
  return TIERS.find((t) => t.key === key) || { key: "UNRANKED", label: "UNRANKED", color: "#8A8F98", glow: "rgba(138,143,152,.25)" };
}

/* ---------------- sound manager (synthesized, no external audio) ---------------- */
function useSoundManager() {
  const [enabled, setEnabled] = useState(true);
  const ctxRef = useRef(null);
  useEffect(() => {
    dbGet(SOUND_KEY, false).then((v) => { if (v !== null) setEnabled(v.on); });
  }, []);
  const ensureCtx = () => {
    if (!ctxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new AC();
    }
    if (ctxRef.current.state === "suspended") ctxRef.current.resume();
    return ctxRef.current;
  };
  const tone = useCallback((freq, dur, type = "sine", gain = 0.08, delay = 0) => {
    if (!enabled) return;
    try {
      const ctx = ensureCtx();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
      g.gain.setValueAtTime(0, ctx.currentTime + delay);
      g.gain.linearRampToValueAtTime(gain, ctx.currentTime + delay + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + dur + 0.02);
    } catch {}
  }, [enabled]);
  const sounds = useMemo(() => ({
    click: () => tone(440, 0.05, "square", 0.04),
    hover: () => tone(600, 0.03, "sine", 0.02),
    found: () => { tone(523, 0.08, "triangle"); tone(784, 0.12, "triangle", 0.08, 0.08); },
    reveal: () => { tone(220, 0.15, "sawtooth", 0.05); tone(440, 0.15, "sawtooth", 0.05, 0.1); tone(660, 0.2, "sawtooth", 0.06, 0.2); },
    success: () => { tone(392, 0.1, "triangle"); tone(523, 0.1, "triangle", 0.08, 0.1); tone(659, 0.2, "triangle", 0.09, 0.2); },
    error: () => { tone(180, 0.2, "sawtooth", 0.07); tone(120, 0.25, "sawtooth", 0.07, 0.1); },
    coin: () => { for (let i = 0; i < 6; i++) tone(700 + i * 60, 0.06, "square", 0.03, i * 0.06); },
    tier: () => { tone(261, 0.12, "triangle"); tone(329, 0.12, "triangle", 0.08, 0.12); tone(392, 0.12, "triangle", 0.08, 0.24); tone(523, 0.3, "triangle", 0.1, 0.36); },
    verdict: () => { tone(80, 0.4, "sawtooth", 0.08); tone(160, 0.3, "square", 0.05, 0.05); },
  }), [tone]);
  const toggle = () => {
    setEnabled((e) => { const n = !e; dbSet(SOUND_KEY, { on: n }, false); return n; });
  };
  return { sounds, enabled, toggle };
}

/* ---------------- image compression ---------------- */
function fileToCompressedDataUrl(file, maxSize = 220, quality = 0.6) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Not an image file."));
    if (file.size > 8 * 1024 * 1024) return reject(new Error("Image too large (max 8MB)."));
    const img = new window.Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.onload = () => {
      const canvas = document.createElement("canvas");
      let { width, height } = img;
      if (width > height) { if (width > maxSize) { height *= maxSize / width; width = maxSize; } }
      else { if (height > maxSize) { width *= maxSize / height; height = maxSize; } }
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Could not read image."));
    img.src = e.target.result; };
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

/* ---------------- small UI atoms ---------------- */
function Field({ label, children }) {
  return (
    <label className="block mb-3">
      <span className="block text-[11px] tracking-wide text-[#8A8F98] mb-1 font-mono">{label}</span>
      {children}
    </label>
  );
}
const inputCls = "w-full bg-[#14161B] border border-[#2A2E37] rounded-md px-3 py-2 text-[#EDEBE3] caret-[#EDEBE3] text-sm outline-none focus:border-[#FF4D3D] transition-colors";

function Btn({ children, onClick, variant = "primary", className = "", disabled, sounds, type = "button" }) {
  const base = "px-4 py-2.5 rounded-md text-sm font-semibold transition-all active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2";
  const variants = {
    primary: "bg-[#FF4D3D] text-[#0E0F13] hover:bg-[#ff6656]",
    ghost: "bg-transparent border border-[#2A2E37] text-[#EDEBE3] hover:border-[#565B66]",
    dark: "bg-[#1B1E25] text-[#EDEBE3] hover:bg-[#22252D] border border-[#2A2E37]",
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={(e) => { sounds?.click(); onClick?.(e); }}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

function TierBadge({ tier, size = "sm" }) {
  const m = tierMeta(tier);
  const big = size === "lg";
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono font-bold rounded ${big ? "text-sm px-3 py-1" : "text-[11px] px-2 py-0.5"}`}
      style={{ color: m.color, border: `1px solid ${m.color}55`, background: `${m.color}14`, boxShadow: `0 0 16px ${m.glow}` }}
    >
      {tier === "UNRANKED" ? "UNRANKED" : m.label}
    </span>
  );
}

function ScorePanel({ label, value }) {
  return (
    <div className="border border-[#2A2E37] rounded-md px-3 py-2 bg-[#14161B]">
      <div className="text-[10px] font-mono text-[#8A8F98] tracking-wide">{label}</div>
      <div className="text-xl font-bold text-[#EDEBE3]">{value}</div>
    </div>
  );
}

function Loading({ lines }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % lines.length), 700);
    return () => clearInterval(t);
  }, [lines.length]);
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      <div className="w-10 h-10 border-2 border-[#2A2E37] border-t-[#FF4D3D] rounded-full animate-spin" />
      <div className="font-mono text-sm text-[#8A8F98] tracking-wide">{lines[i]}</div>
    </div>
  );
}

function EmptyState({ title, sub }) {
  return (
    <div className="text-center py-16 border border-dashed border-[#2A2E37] rounded-lg">
      <div className="font-mono text-[#EDEBE3] font-bold tracking-wide">{title}</div>
      {sub && <div className="text-sm text-[#8A8F98] mt-1">{sub}</div>}
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  const color = toast.type === "error" ? "#FF4D3D" : toast.type === "warn" ? "#FF9F4D" : "#3DDC97";
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[999] animate-[slideDown_.25s_ease]">
      <div className="font-mono text-sm px-4 py-2.5 rounded-md border shadow-lg" style={{ background: "#14161B", borderColor: color, color }}>
        {toast.text}
      </div>
    </div>
  );
}

/* ============================================================ */
export default function WhoCares() {
  const [booted, setBooted] = useState(false);
  const [users, setUsers] = useState([]);
  const [ratings, setRatings] = useState([]);
  const [reports, setReports] = useState([]);
  const [encounters, setEncounters] = useState([]);
  const [appealCourt, setAppealCourt] = useState(null);
  const [categories, setCategories] = useState(CATEGORY_DEFAULTS);
  const [sessionId, setSessionId] = useState(null);
  const [view, setView] = useState("landing");
  const [authMode, setAuthMode] = useState("register");
  const [viewTarget, setViewTarget] = useState(null);
  const [toast, setToast] = useState(null);
  const sm = useSoundManager();
  const reduceMotion = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches, []);

  const notify = (text, type = "ok") => { setToast({ text, type }); setTimeout(() => setToast(null), 2600); };

  /* ---- boot: load db, seed if empty ---- */
  useEffect(() => {
    (async () => {
      let u = await dbGet(DB_USERS, true);
      let r = await dbGet(DB_RATINGS, true);
      let rep = await dbGet(DB_REPORTS, true);
      let enc = await dbGet(DB_ENCOUNTERS, true);
      let cats = await dbGet(DB_CATEGORIES, true);
      if (!u) { u = await seedUsers(); await dbSet(DB_USERS, u, true); }
      if (!r) { r = seedRatings(u); await dbSet(DB_RATINGS, r, true); }
      if (!rep) { rep = []; await dbSet(DB_REPORTS, rep, true); }
      if (!enc) { enc = []; await dbSet(DB_ENCOUNTERS, enc, true); }
      if (!cats) { cats = CATEGORY_DEFAULTS; await dbSet(DB_CATEGORIES, cats, true); }
      setUsers(u); setRatings(r); setReports(rep); setEncounters(enc); setCategories(cats);
      const sess = await dbGet(SESSION_KEY, false);
      if (sess?.userId && u.find((x) => x.id === sess.userId && !x.deleted)) {
        setSessionId(sess.userId); setView("home");
      }
      setBooted(true);
    })();
  }, []);

  const me = users.find((u) => u.id === sessionId) || null;

  const persistUsers = async (next) => { setUsers(next); await dbSet(DB_USERS, next, true); };
  const persistRatings = async (next) => { setRatings(next); await dbSet(DB_RATINGS, next, true); };
  const persistReports = async (next) => { setReports(next); await dbSet(DB_REPORTS, next, true); };
  const persistEncounters = async (next) => { setEncounters(next); await dbSet(DB_ENCOUNTERS, next, true); };

  /* ---- auth ---- */
  const register = async (form) => {
    const nickTaken = users.some((u) => u.nickname.toLowerCase() === form.nickname.toLowerCase());
    const emailTaken = users.some((u) => u.email.toLowerCase() === form.email.toLowerCase());
    if (nickTaken) throw new Error("THAT NICKNAME IS ALREADY REGISTERED TO A HUMAN.");
    if (emailTaken) throw new Error("THIS EMAIL IS ALREADY ON FILE.");
    if (!/^[a-zA-Z0-9_.]{3,20}$/.test(form.nickname)) throw new Error("NICKNAME MUST BE 3–20 CHARS: LETTERS, NUMBERS, . OR _");
    if (form.password.length < 6) throw new Error("PASSWORD MUST BE AT LEAST 6 CHARACTERS.");
    if (!form.selfie) throw new Error("A SELFIE IS REQUIRED. NO HUMAN, NO PROFILE.");
    const passwordHash = await sha256(form.password + "::hr-salt");
    const id = crypto.randomUUID();
    const user = {
      id, nickname: form.nickname, email: form.email, passwordHash,
      realName: form.realName, showRealName: false,
      gender: form.gender, height: form.height, beard: form.beard,
      hair: form.hair, bald: form.bald, glasses: form.glasses,
      college: form.college, workplace: form.workplace,
      area: form.area, selfie: form.selfie,
      discoverable: form.discoverable,
      isAdmin: false, suspended: false, deleted: false,
      createdAt: Date.now(),
    };
    await persistUsers([...users, user]);
    await dbSet(SESSION_KEY, { userId: id }, false);
    setSessionId(id);
    notify("HUMAN REGISTERED. WELCOME TO THE SYSTEM.");
    setView("home");
  };

  const login = async (identifier, password) => {
    const passwordHash = await sha256(password + "::hr-salt");
    const u = users.find(
      (x) => !x.deleted && (x.nickname.toLowerCase() === identifier.toLowerCase() || x.email.toLowerCase() === identifier.toLowerCase())
    );
    if (!u || u.passwordHash !== passwordHash) throw new Error("CREDENTIALS REJECTED. THIS HUMAN COULD NOT BE VERIFIED.");
    if (u.suspended) throw new Error("THIS ACCOUNT HAS BEEN SUSPENDED BY THE COUNCIL.");
    await dbSet(SESSION_KEY, { userId: u.id }, false);
    setSessionId(u.id);
    notify(`WELCOME BACK, @${u.nickname}.`);
    setView("home");
  };

  const logout = async () => {
    await dbSet(SESSION_KEY, { userId: null }, false);
    setSessionId(null);
    setView("landing");
  };

  /* ---- ratings / reviews ---- */
  const submitJudgement = async (targetId, catValues, reviewText) => {
    if (!me) throw new Error("YOU MUST BE LOGGED IN TO JUDGE A HUMAN.");
    if (targetId === me.id) throw new Error("YOU CANNOT JUDGE YOURSELF. NICE TRY.");
    const dup = ratings.find((r) => r.reviewerId === me.id && r.targetId === targetId && !r.deleted);
    if (dup) throw new Error("YOU HAVE ALREADY JUDGED THIS HUMAN.");
    if (!reviewText.trim()) throw new Error("A REVIEW IS REQUIRED. SILENCE IS NOT A VERDICT.");
    if (reviewText.length > 200) throw new Error("REVIEW EXCEEDS 200 CHARACTERS.");
    if (/<script|https?:\/\//i.test(reviewText)) throw new Error("THIS REVIEW FAILED HUMANITY CHECK.");
    const rating = {
      id: crypto.randomUUID(), reviewerId: me.id, targetId, categories: catValues,
      reviewText: reviewText.trim(), createdAt: Date.now(),
      appealUsed: false, appealResult: null, deleted: false,
    };
    await persistRatings([...ratings, rating]);
    return rating;
  };

  const appealRating = async (ratingId) => {
    const r = ratings.find((x) => x.id === ratingId);
    if (!r) throw new Error("REVIEW NOT FOUND.");
    if (r.targetId !== me.id) throw new Error("NOT AUTHORIZED TO APPEAL THIS REVIEW.");
    if (r.appealUsed) throw new Error("THIS REVIEW HAS ALREADY BEEN APPEALED.");
    const result = secureCoinToss();
    setAppealCourt({ open: true, stage: "deliberation", result: null, reviewText: r.reviewText, caseId: r.id.slice(0, 8).toUpperCase() });
    setTimeout(() => setAppealCourt((c) => c?.open ? { ...c, stage: "flipping" } : c), 900);
    setTimeout(() => {
      setAppealCourt((c) => c?.open ? { ...c, stage: "result", result } : c);
      result === "HEADS" ? sm.sounds.success() : sm.sounds.error();
    }, 3000);
    setTimeout(() => setAppealCourt(null), 5600);
    const next = ratings.map((x) => x.id === ratingId
      ? { ...x, appealUsed: true, appealResult: result, deleted: result === "HEADS" ? true : x.deleted, appealedAt: Date.now() }
      : x);
    await persistRatings(next);
    return result;
  };

  const reportReview = async (ratingId, reason, details) => {
    const rep = { id: crypto.randomUUID(), ratingId, reporterId: me?.id || null, reason, details: details || "", createdAt: Date.now(), status: "open" };
    await persistReports([...reports, rep]);
  };

  /* ---- profile edits ---- */
  const updateMe = async (patch) => {
    const next = users.map((u) => (u.id === me.id ? { ...u, ...patch } : u));
    await persistUsers(next);
  };
  const changePassword = async (oldPw, newPw) => {
    const oldHash = await sha256(oldPw + "::hr-salt");
    if (oldHash !== me.passwordHash) throw new Error("CURRENT PASSWORD IS INCORRECT.");
    if (newPw.length < 6) throw new Error("NEW PASSWORD TOO SHORT.");
    const newHash = await sha256(newPw + "::hr-salt");
    await updateMe({ passwordHash: newHash });
  };
  const deleteAccount = async () => {
    await updateMe({ deleted: true, discoverable: false });
    await logout();
    notify("ACCOUNT DEACTIVATED. YOUR REVIEWS REMAIN, ANONYMIZED.");
  };

  /* ---- admin ---- */
  const adminDeleteRating = async (id) => {
    await persistRatings(ratings.map((r) => (r.id === id ? { ...r, deleted: true } : r)));
  };
  const adminSuspend = async (id, suspended) => {
    await persistUsers(users.map((u) => (u.id === id ? { ...u, suspended } : u)));
  };
  const adminCloseReport = async (id) => {
    await persistReports(reports.map((r) => (r.id === id ? { ...r, status: "closed" } : r)));
  };

  const goProfile = (id) => { setViewTarget(id); setView("profile"); };

  if (!booted) return <Shell dark><Loading lines={["Booting the Ministry of Human Evaluation...", "Reticulating splines...", "Consulting absolutely unnecessary algorithms..."]} /></Shell>;

  return (
    <Shell>
      <Toast toast={toast} />
      <TopBar me={me} view={view} setView={setView} setViewTarget={setViewTarget} logout={logout} sm={sm} />
      <main className="max-w-5xl mx-auto px-4 pb-24 pt-6">
        {view === "landing" && <Landing setView={setView} setAuthMode={setAuthMode} sm={sm} />}
        {view === "auth" && <AuthScreen initialMode={authMode} register={register} login={login} notify={notify} sm={sm} />}
        {view === "home" && me && (
          <Home me={me} users={users} ratings={ratings} categories={categories} setView={setView} goProfile={goProfile} sm={sm} />
        )}
        {view === "search" && me && <SearchScreen users={users} ratings={ratings} categories={categories} me={me} goProfile={goProfile} sm={sm} />}
        {view === "profile" && me && (
          <ProfileScreen
            id={viewTarget || me.id} me={me} users={users} ratings={ratings} categories={categories} encounters={encounters}
            goProfile={goProfile} setView={setView} sm={sm} notify={notify}
            submitJudgement={submitJudgement} appealRating={appealRating} reportReview={reportReview}
          />
        )}
        {view === "leaderboard" && me && <Leaderboard users={users} ratings={ratings} categories={categories} goProfile={goProfile} sm={sm} />}
        {view === "random" && me && <RandomHuman users={users} ratings={ratings} categories={categories} me={me} goProfile={goProfile} setView={setView} sm={sm} />}
        {view === "report" && me && <HumanReport user={users.find((u) => u.id === (viewTarget || me.id)) || me} users={users} ratings={ratings} categories={categories} setView={setView} sm={sm} />}
        {view === "compatibility" && me && viewTarget && <Compatibility me={me} target={users.find((u) => u.id === viewTarget)} ratings={ratings} categories={categories} setView={setView} sm={sm} />}
        {view === "certificate" && me && <HumanCertificate user={users.find((u) => u.id === (viewTarget || me.id)) || me} ratings={ratings} categories={categories} setView={setView} />}
        {view === "qr" && me && <QRScreen me={me} users={users} encounters={encounters} persistEncounters={persistEncounters} goProfile={goProfile} notify={notify} sm={sm} />}
        {view === "settings" && me && (
          <SettingsScreen me={me} updateMe={updateMe} changePassword={changePassword} deleteAccount={deleteAccount} notify={notify} sm={sm} />
        )}
        {view === "admin" && me?.isAdmin && (
          <AdminScreen users={users} ratings={ratings} reports={reports} categories={categories}
            adminDeleteRating={adminDeleteRating} adminSuspend={adminSuspend} adminCloseReport={adminCloseReport} goProfile={goProfile} />
        )}
      </main>
      {appealCourt && <AppealCourt court={appealCourt} />}
      <style>{`
        @keyframes slideDown { from { opacity:0; transform: translate(-50%,-12px);} to {opacity:1; transform: translate(-50%,0);} }
        @keyframes flipcoin { 0%{transform:rotateY(0deg);} 100%{transform:rotateY(1800deg);} }
        @keyframes popIn { from {opacity:0; transform: scale(.9);} to {opacity:1; transform: scale(1);} }
        @keyframes courtIn { from { opacity:0; transform:scale(1.02); } to { opacity:1; transform:scale(1); } }
        @keyframes pulseCourt { 0%,100%{opacity:.65; transform:scale(1)} 50%{opacity:1; transform:scale(1.03)} }
        @keyframes courtCoin { 0%{transform:rotateY(0deg) translateY(0) rotateX(0deg)} 25%{transform:rotateY(540deg) translateY(-55px) rotateX(180deg)} 50%{transform:rotateY(1080deg) translateY(-10px) rotateX(360deg)} 75%{transform:rotateY(1620deg) translateY(-45px) rotateX(540deg)} 100%{transform:rotateY(2160deg) translateY(0) rotateX(720deg)} }
        @keyframes verdictIn { from { opacity:0; transform:scale(.55) rotate(-3deg); filter:blur(6px); } to { opacity:1; transform:scale(1) rotate(0); filter:blur(0); } }
        input, textarea, select { color: #EDEBE3 !important; }
        input::placeholder, textarea::placeholder { color: #8A8F98 !important; opacity: 1; }
        select option { background: #14161B; color: #EDEBE3; }
        ${reduceMotion ? "*{animation-duration:.001s !important; transition-duration:.001s !important;}" : ""}
      `}</style>
    </Shell>
  );
}

function Shell({ children, dark }) {
  return (
    <div className={`min-h-screen ${dark ? "" : ""}`} style={{ background: "#0E0F13", color: "#EDEBE3", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      {children}
    </div>
  );
}

function TopBar({ me, view, setView, setViewTarget, logout, sm }) {
  if (view === "landing" || view === "auth") return null;
  const items = [
    { k: "home", label: "Home" },
    { k: "search", label: "Search" },
    { k: "leaderboard", label: "Leaderboard" },
    { k: "qr", label: "My QR" },
  ];
  return (
    <header className="sticky top-0 z-50 border-b border-[#1E212A] backdrop-blur-md" style={{ background: "rgba(14,15,19,0.9)" }}>
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => { sm.sounds.click(); setView("home"); }}>
          <Gavel size={18} color="#FF4D3D" />
          <span className="font-bold tracking-tight text-sm">WHO_CARES?</span>
        </div>
        <nav className="hidden sm:flex items-center gap-1">
          {items.map((it) => (
            <button key={it.k} onClick={() => { sm.sounds.click(); setView(it.k); }}
              className={`px-3 py-1.5 rounded-md text-xs font-mono transition-colors ${view === it.k ? "bg-[#1B1E25] text-[#EDEBE3]" : "text-[#8A8F98] hover:text-[#EDEBE3]"}`}>
              {it.label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <button onClick={sm.toggle} className="p-2 text-[#8A8F98] hover:text-[#EDEBE3]" title="Sound">
            {sm.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          {me?.isAdmin && (
            <button onClick={() => { sm.sounds.click(); setView("admin"); }} className="p-2 text-[#8A8F98] hover:text-[#EDEBE3]" title="Admin">
              <Shield size={16} />
            </button>
          )}
          <button onClick={() => { sm.sounds.click(); setView("settings"); }} className="p-2 text-[#8A8F98] hover:text-[#EDEBE3]" title="Settings">
            <Settings size={16} />
          </button>
          {me && (
            <button onClick={() => { sm.sounds.click(); setViewTarget(me.id); setView("profile"); }} className="flex items-center gap-1.5">
              <img src={me.selfie} className="w-7 h-7 rounded-full object-cover border border-[#2A2E37]" alt="" />
            </button>
          )}
          {me && <button onClick={() => { sm.sounds.click(); logout(); }} className="p-2 text-[#8A8F98] hover:text-[#FF4D3D]" title="Logout"><LogOut size={16} /></button>}
        </div>
      </div>
      <nav className="sm:hidden flex overflow-x-auto gap-1 px-4 pb-2">
        {items.map((it) => (
          <button key={it.k} onClick={() => { sm.sounds.click(); setView(it.k); }}
            className={`px-3 py-1 rounded-md text-xs font-mono whitespace-nowrap ${view === it.k ? "bg-[#1B1E25]" : "text-[#8A8F98]"}`}>
            {it.label}
          </button>
        ))}
      </nav>
    </header>
  );
}

/* ---------------- LANDING ---------------- */
function Landing({ setView, setAuthMode, sm }) {
  return (
    <div className="max-w-2xl mx-auto text-center pt-10 pb-10">
      <div className="inline-flex items-center gap-2 font-mono text-[11px] text-[#8A8F98] border border-[#2A2E37] rounded-full px-3 py-1 mb-8">
        <span className="w-1.5 h-1.5 rounded-full bg-[#3DDC97]" /> SYSTEM OPERATIONAL · ACCEPTING NEW HUMANS FOR EVALUATION
      </div>
      <h1 className="text-4xl sm:text-5xl font-black tracking-tight leading-[1.05]">
        Every human deserves<br />a <span style={{ color: "#FF4D3D" }}>product page.</span>
      </h1>
      <p className="text-[#8A8F98] mt-5 text-base leading-relaxed max-w-md mx-auto">
        Register your human. Get a spec sheet. Get discovered, get judged,
        get a tier. It solves nothing. It was never meant to.
      </p>
      <div className="flex items-center justify-center gap-3 mt-8">
        <Btn sounds={sm.sounds} onClick={() => { setAuthMode("register"); setView("auth"); }}>Register as a Human <ChevronRight size={16} /></Btn>
        <Btn sounds={sm.sounds} variant="ghost" onClick={() => { setAuthMode("login"); setView("auth"); }}>I already exist</Btn>
      </div>
      <div className="grid grid-cols-3 gap-3 mt-14 text-left">
        {[
          { icon: <ScanFace size={16} />, t: "SELFIE-VERIFIED", d: "One human, one face on file." },
          { icon: <Dices size={16} />, t: "COIN-SETTLED APPEALS", d: "50/50, server-decided, no mercy." },
          { icon: <Trophy size={16} />, t: "TIERED BY ALGORITHM", d: "S through E. Confidence-weighted." },
        ].map((f, i) => (
          <div key={i} className="border border-[#2A2E37] rounded-lg p-4">
            <div className="text-[#FF4D3D] mb-2">{f.icon}</div>
            <div className="font-mono text-xs font-bold">{f.t}</div>
            <div className="text-xs text-[#8A8F98] mt-1">{f.d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- AUTH ---------------- */
function AuthScreen({ initialMode = "register", register, login, notify, sm }) {
  const [mode, setMode] = useState(initialMode);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    realName: "", nickname: "", email: "", password: "", gender: "Unspecified",
    height: "", beard: "None", hair: "Short", bald: "No", glasses: "No",
    college: "", workplace: "", area: "", discoverable: true, selfie: null,
  });
  const [loginId, setLoginId] = useState(""); const [loginPw, setLoginPw] = useState("");

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState("");

  const openCamera = async () => {
    setCameraError("");
    setCameraOpen(false);

    // Stop any previous stream before requesting a fresh one.
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");

      let stream;
      try {
        // Prefer the front/selfie camera.
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "user" },
            width: { ideal: 720 },
            height: { ideal: 960 }
          },
          audio: false
        });
      } catch (_) {
        // Fallback for browsers that reject camera constraints.
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      }

      streamRef.current = stream;
      setCameraOpen(true);

      // React needs to render the video element before attaching the stream.
      requestAnimationFrame(async () => {
        const video = videoRef.current;
        if (!video) return;

        video.srcObject = stream;
        video.muted = true;
        video.setAttribute("playsinline", "true");

        try {
          await video.play();
        } catch (_) {
          setTimeout(() => video.play().catch(() => {}), 150);
        }

        // Detect the occasional black/uninitialized preview.
        setTimeout(() => {
          if (videoRef.current === video && !video.videoWidth) {
            setCameraError("CAMERA STARTED BUT NO VIDEO FRAME WAS RECEIVED. TAP RETRY CAMERA.");
          }
        }, 1200);
      });

      stream.getVideoTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          if (streamRef.current === stream) {
            setCameraError("CAMERA STOPPED. PLEASE TAP RETRY CAMERA.");
            setCameraOpen(false);
          }
        });
      });
    } catch (ex) {
      const name = ex?.name || "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setCameraError("CAMERA PERMISSION IS BLOCKED. ALLOW CAMERA ACCESS, THEN TAP RETRY CAMERA.");
      } else if (name === "NotReadableError" || name === "TrackStartError") {
        setCameraError("CAMERA IS BUSY IN ANOTHER APP. CLOSE OTHER CAMERA/VIDEO APPS, THEN RETRY.");
      } else if (name === "NotFoundError") {
        setCameraError("NO CAMERA WAS FOUND ON THIS DEVICE.");
      } else {
        setCameraError("CAMERA COULD NOT START. CHECK CAMERA PERMISSION AND TAP RETRY CAMERA.");
      }
    }
  };
  const closeCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    setCameraOpen(false);
    setCameraError("");
  };
  const takeSelfie = async () => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video?.videoHeight) { setCameraError("CAMERA IS NOT READY YET. WAIT A MOMENT OR TAP RETRY CAMERA."); return; }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.75);
    setForm((s) => ({ ...s, selfie: url }));
    closeCamera();
  };

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      if (mode === "register") await register(form);
      else await login(loginId, loginPw);
      sm.sounds.success();
    } catch (ex) { setErr(ex.message); sm.sounds.error(); }
    setBusy(false);
  };

  return (
    <div className="max-w-md mx-auto pt-4">
      <div className="flex border border-[#2A2E37] rounded-md overflow-hidden mb-6">
        <button onClick={() => { setMode("register"); setErr(""); }} className={`flex-1 py-2.5 text-sm font-mono ${mode === "register" ? "bg-[#1B1E25]" : "text-[#8A8F98]"}`}>REGISTER</button>
        <button onClick={() => { setMode("login"); setErr(""); }} className={`flex-1 py-2.5 text-sm font-mono ${mode === "login" ? "bg-[#1B1E25]" : "text-[#8A8F98]"}`}>LOGIN</button>
      </div>

      {err && <div className="mb-4 text-sm font-mono text-[#FF4D3D] border border-[#FF4D3D33] bg-[#FF4D3D0d] rounded-md px-3 py-2">{err}</div>}

      {mode === "login" ? (
        <div>
          <Field label="NICKNAME OR EMAIL"><input className={inputCls} value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="@arjun.exe" /></Field>
          <Field label="PASSWORD"><input type="password" className={inputCls} value={loginPw} onChange={(e) => setLoginPw(e.target.value)} /></Field>
          <div className="text-[11px] font-mono text-[#565B66] mb-4">Demo admin: <b>admin</b> / <b>admin1234</b></div>
          <Btn sounds={sm.sounds} disabled={busy} onClick={submit} className="w-full">{busy ? "VERIFYING..." : "ENTER THE SYSTEM"}</Btn>
        </div>
      ) : (
        <div>
          <div className="border border-dashed border-[#2A2E37] rounded-lg p-4 mb-4">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-[#14161B] border border-[#2A2E37] overflow-hidden flex items-center justify-center shrink-0">
                {form.selfie ? <img src={form.selfie} className="w-full h-full object-cover" alt="Captured selfie" /> : <Camera size={20} className="text-[#565B66]" />}
              </div>
              <div>
                {!form.selfie ? (
                  <Btn sounds={sm.sounds} variant="ghost" onClick={openCamera}><Camera size={15} /> OPEN CAMERA</Btn>
                ) : (
                  <div className="text-xs font-mono text-[#3DDC97]">SELFIE CAPTURED ✓</div>
                )}
                <div className="text-[11px] text-[#8A8F98] mt-1">Camera capture only. Image upload is disabled.</div>
              </div>
            </div>
            {cameraError && <div className="text-xs font-mono text-[#FF4D3D] mt-3">{cameraError}</div>}
          </div>

          {cameraOpen && (
            <div className="fixed inset-0 z-[1000] bg-black/90 flex items-center justify-center p-4">
              <div className="w-full max-w-md border border-[#2A2E37] rounded-xl bg-[#14161B] p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-mono text-xs font-bold">TAKE YOUR SELFIE</div>
                  <button onClick={closeCamera}><X size={18} className="text-[#8A8F98]" /></button>
                </div>
                <video ref={videoRef} autoPlay playsInline muted onCanPlay={() => setCameraError("")} className="w-full aspect-[3/4] object-cover rounded-lg bg-black" />
                <div className="flex gap-2 mt-3">
                  <Btn sounds={sm.sounds} onClick={takeSelfie} className="flex-1"><Camera size={15} /> CAPTURE</Btn>
                  <Btn sounds={sm.sounds} variant="ghost" onClick={closeCamera}>CANCEL</Btn>
                </div>
              </div>
            </div>
          )}

          <Field label="REAL NAME (never public)"><input className={inputCls} value={form.realName} onChange={(e) => setForm({ ...form, realName: e.target.value })} /></Field>
          <Field label="NICKNAME (public, unique)"><input className={inputCls} value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} placeholder="arjun.exe" /></Field>
          <Field label="EMAIL (private)"><input type="email" className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="PASSWORD"><input type="password" className={inputCls} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="GENDER"><select className={inputCls} value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
              {["Unspecified", "Male", "Female", "Non-binary"].map((o) => <option key={o}>{o}</option>)}
            </select></Field>
            <Field label="HEIGHT (cm)"><input type="number" className={inputCls} value={form.height} onChange={(e) => setForm({ ...form, height: e.target.value })} /></Field>
            <Field label="BEARD"><select className={inputCls} value={form.beard} onChange={(e) => setForm({ ...form, beard: e.target.value })}>
              {["None", "Stubble", "Full"].map((o) => <option key={o}>{o}</option>)}
            </select></Field>
            <Field label="HAIR LENGTH"><select className={inputCls} value={form.hair} onChange={(e) => setForm({ ...form, hair: e.target.value })}>
              {["Bald", "Short", "Medium", "Long"].map((o) => <option key={o}>{o}</option>)}
            </select></Field>
            <Field label="BALD STATUS"><select className={inputCls} value={form.bald} onChange={(e) => setForm({ ...form, bald: e.target.value })}>
              {["No", "Partially", "Yes"].map((o) => <option key={o}>{o}</option>)}
            </select></Field>
            <Field label="GLASSES"><select className={inputCls} value={form.glasses} onChange={(e) => setForm({ ...form, glasses: e.target.value })}>
              {["No", "Yes"].map((o) => <option key={o}>{o}</option>)}
            </select></Field>
          </div>
          <Field label="COLLEGE / UNIVERSITY"><input className={inputCls} value={form.college} onChange={(e) => setForm({ ...form, college: e.target.value })} /></Field>
          <Field label="WORKPLACE / ORGANIZATION"><input className={inputCls} value={form.workplace} onChange={(e) => setForm({ ...form, workplace: e.target.value })} /></Field>
          <Field label="APPROXIMATE AREA (never exact location)"><input className={inputCls} value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} placeholder="e.g. Kochi, Ernakulam district" /></Field>

          <label className="flex items-center gap-2 mb-5 mt-2 cursor-pointer">
            <input type="checkbox" checked={form.discoverable} onChange={(e) => setForm({ ...form, discoverable: e.target.checked })} />
            <span className="text-xs font-mono text-[#8A8F98]">Make me discoverable in search & leaderboard</span>
          </label>

          <Btn sounds={sm.sounds} disabled={busy} onClick={submit} className="w-full">{busy ? "PROCESSING..." : "SUBMIT HUMAN FOR REGISTRATION"}</Btn>
        </div>
      )}
    </div>
  );
}

/* ---------------- HOME ---------------- */
function Home({ me, users, ratings, categories, setView, goProfile, sm }) {
  const discoverable = users.filter((u) => u.discoverable && !u.deleted && !u.suspended);
  const withStats = discoverable.map((u) => ({ u, stats: computeStats(u.id, ratings, categories) }));
  const ranked = withStats.filter((x) => x.stats.count >= MIN_REVIEWS_FOR_TIER).sort((a, b) => b.stats.score - a.stats.score);
  const featured = ranked.slice(0, 3);
  const sTier = ranked.filter((x) => x.stats.tier === "S");
  const eTier = ranked.filter((x) => x.stats.tier === "E");
  const recent = [...ratings].filter((r) => !r.deleted).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  const myStats = computeStats(me.id, ratings, categories);

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div className="font-mono text-[11px] text-[#8A8F98]">WELCOME BACK</div>
          <h2 className="text-2xl font-bold">@{me.nickname}</h2>
        </div>
        <div className="flex gap-2">
          <Btn sounds={sm.sounds} onClick={() => setView("search")}><Search size={15} /> LOCATE HUMAN</Btn>
          <Btn sounds={sm.sounds} onClick={() => setView("random")} variant="dark"><Zap size={15} /> SUMMON RANDOM HUMAN</Btn>
          <Btn sounds={sm.sounds} variant="ghost" onClick={() => setView("qr")}><QrCode size={15} /> My QR</Btn>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-10">
        <ScorePanel label="AURA INDEX™" value={myStats.count ? myStats.score : "—"} />
        <ScorePanel label="YOUR TIER" value={<TierBadge tier={myStats.tier} />} />
        <ScorePanel label="ENCOUNTERS" value={myStats.count} />
      </div>

      <Section title="GLOBAL AURA AUTHORITY" sub="The chosen few. Their presence has been statistically documented.">
        {sTier.length ? (
          <Row items={sTier} goProfile={goProfile} sm={sm} />
        ) : <EmptyState title="NO S-TIER HUMANS YET" sub="The bar is high. Someone has to earn it." />}
      </Section>

      <Section title="TODAY'S SPECIMENS" sub="A rotating sample of humanity currently under investigation.">
        {featured.length ? <Row items={featured} goProfile={goProfile} sm={sm} /> : <EmptyState title="NOT ENOUGH DATA YET" sub="Judge a few humans to populate this section." />}
      </Section>

      <Section title="E-Tier Legends" sub="Not ranked worst. Just... legendary in a different direction.">
        {eTier.length ? <Row items={eTier} goProfile={goProfile} sm={sm} /> : <EmptyState title="NO E-TIER LEGENDS YET" sub="Give it time." />}
      </Section>

      <Section title="RECENT HUMAN INCIDENTS" sub="Someone, somewhere, was recently evaluated.">
        {recent.length ? (
          <div className="space-y-2">
            {recent.map((r) => {
              const target = users.find((u) => u.id === r.targetId);
              if (!target) return null;
              return (
                <div key={r.id} className="border border-[#2A2E37] rounded-md px-4 py-3 flex items-center gap-3 cursor-pointer hover:border-[#565B66]" onClick={() => goProfile(target.id)}>
                  <img src={target.selfie} className="w-8 h-8 rounded-full object-cover" alt="" />
                  <div className="min-w-0">
                    <div className="text-xs font-mono text-[#8A8F98]">@{target.nickname} was judged</div>
                    <div className="text-sm truncate">"{r.reviewText}"</div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : <EmptyState title="NO JUDGEMENTS YET" sub="Someone deserves to be judged." />}
      </Section>
    </div>
  );
}

function Section({ title, sub, children }) {
  return (
    <div className="mb-10">
      <div className="mb-3">
        <h3 className="font-bold text-lg">{title}</h3>
        {sub && <div className="text-xs text-[#8A8F98]">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Row({ items, goProfile, sm }) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {items.map(({ u, stats }) => (
        <div key={u.id} onClick={() => { sm.sounds.click(); goProfile(u.id); }}
          className="min-w-[160px] border border-[#2A2E37] rounded-lg p-3 cursor-pointer hover:border-[#565B66] transition-colors bg-[#14161B]">
          <img src={u.selfie} className="w-full h-28 object-cover rounded-md mb-2" alt="" />
          <div className="font-mono text-xs font-bold truncate">@{u.nickname}</div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-sm font-black">✨ {stats.score}</span>
            <TierBadge tier={stats.tier} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- SEARCH ---------------- */
function SearchScreen({ users, ratings, categories, me, goProfile, sm }) {
  const [q, setQ] = useState("");
  const [gender, setGender] = useState("");
  const [beard, setBeard] = useState("");
  const [glasses, setGlasses] = useState("");
  const [college, setCollege] = useState("");
  const [searching, setSearching] = useState(false);
  const [ran, setRan] = useState(false);

  const doSearch = () => {
    sm.sounds.click();
    setSearching(true); setRan(false);
    setTimeout(() => { setSearching(false); setRan(true); sm.sounds.found(); }, 650);
  };

  const results = useMemo(() => {
    if (!ran) return [];
    return users.filter((u) => {
      if (u.deleted || u.suspended || !u.discoverable) return false;
      if (u.id === me.id) return false;
      if (q && !u.nickname.toLowerCase().includes(q.toLowerCase())) return false;
      if (gender && u.gender !== gender) return false;
      if (beard && u.beard !== beard) return false;
      if (glasses && u.glasses !== glasses) return false;
      if (college && !(u.college || "").toLowerCase().includes(college.toLowerCase())) return false;
      return true;
    });
  }, [ran, users, q, gender, beard, glasses, college, me.id]);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-1">LOCATE HUMAN</h2>
      <p className="text-xs text-[#8A8F98] mb-6">Real names are never searchable. Only discoverable humans appear.</p>

      <div className="border border-[#2A2E37] rounded-lg p-4 mb-6 bg-[#14161B]">
        <Field label="NICKNAME"><input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="arjun.exe" /></Field>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="GENDER"><select className={inputCls} value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="">Any</option>{["Male", "Female", "Non-binary", "Unspecified"].map((o) => <option key={o}>{o}</option>)}
          </select></Field>
          <Field label="BEARD"><select className={inputCls} value={beard} onChange={(e) => setBeard(e.target.value)}>
            <option value="">Any</option>{["None", "Stubble", "Full"].map((o) => <option key={o}>{o}</option>)}
          </select></Field>
          <Field label="GLASSES"><select className={inputCls} value={glasses} onChange={(e) => setGlasses(e.target.value)}>
            <option value="">Any</option>{["No", "Yes"].map((o) => <option key={o}>{o}</option>)}
          </select></Field>
          <Field label="COLLEGE"><input className={inputCls} value={college} onChange={(e) => setCollege(e.target.value)} /></Field>
        </div>
        <Btn sounds={sm.sounds} onClick={doSearch} className="mt-1"><Search size={15} /> SCAN HUMAN DATABASE</Btn>
      </div>

      {searching && <Loading lines={["Scanning available humans...", "Cross-referencing spec sheets...", "Almost done judging..."]} />}
      {!searching && ran && (
        results.length ? (
          <>
            <div className="font-mono text-xs text-[#8A8F98] mb-3">{results.length} HUMAN{results.length !== 1 ? "S" : ""} FOUND</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {results.map((u) => {
                const stats = computeStats(u.id, ratings, categories);
                return (
                  <div key={u.id} onClick={() => goProfile(u.id)} className="border border-[#2A2E37] rounded-lg p-3 cursor-pointer hover:border-[#565B66] bg-[#14161B]">
                    <img src={u.selfie} className="w-full h-32 object-cover rounded-md mb-2" alt="" />
                    <div className="font-mono text-xs font-bold truncate">@{u.nickname}</div>
                    <div className="text-[11px] text-[#8A8F98] truncate">{u.college || u.workplace || "No public affiliation"}</div>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-sm font-bold">{stats.count ? stats.score : "—"}</span>
                      <TierBadge tier={stats.tier} />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : <EmptyState title="NO HUMANS FOUND" sub="Adjust your filters or try a different nickname." />
      )}
    </div>
  );
}

/* ---------------- PROFILE ---------------- */
function ProfileScreen({ id, me, users, ratings, categories, encounters, goProfile, setView, sm, notify, submitJudgement, appealRating, reportReview }) {
  const u = users.find((x) => x.id === id);
  const [showRate, setShowRate] = useState(false);
  const [tab, setTab] = useState("overview");
  useEffect(() => { setTab("overview"); }, [id]);
  if (!u) return <EmptyState title="HUMAN NOT FOUND" sub="This human may have deactivated." />;
  const isMe = u.id === me.id;
  const stats = computeStats(u.id, ratings, categories);
  const myRatingOfThem = ratings.find((r) => r.reviewerId === me.id && r.targetId === u.id && !r.deleted);
  const receivedReviews = ratings.filter((r) => r.targetId === u.id && !r.deleted).sort((a, b) => b.createdAt - a.createdAt);
  const postedReviews = ratings.filter((r) => r.reviewerId === u.id && !r.deleted).sort((a, b) => b.createdAt - a.createdAt);
  const humanEncounters = encounters.filter((e) => isMe ? (e.viewerId === u.id || e.targetId === u.id) : e.targetId === u.id).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div>
      <div className="border border-[#2A2E37] rounded-xl p-5 bg-[#14161B] mb-6" style={{ boxShadow: `0 0 40px ${tierMeta(stats.tier).glow}` }}>
        <div className="flex flex-col sm:flex-row gap-5">
          <img src={u.selfie} className="w-28 h-28 rounded-lg object-cover border border-[#2A2E37] shrink-0" alt="" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-bold">@{u.nickname}</h2>
              <TierBadge tier={stats.tier} size="lg" />
            </div>
            <div className="font-mono text-[11px] text-[#8A8F98] mt-1">HUMAN STATUS: {u.suspended ? "SUSPENDED" : "OPERATIONAL"}</div>
            {u.showRealName && u.realName && <div className="text-xs text-[#8A8F98] mt-1">Also known as: {u.realName}</div>}
            <div className="grid grid-cols-3 gap-2 mt-4 max-w-xs">
              <ScorePanel label="AURA INDEX™" value={stats.count ? stats.score : "N/A"} />
              <ScorePanel label="REVIEWS" value={stats.count} />
              <ScorePanel label="ENCOUNTERS" value={humanEncounters.length} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-5 font-mono text-[11px]">
          <Spec label="Model" value={u.gender} />
          <Spec label="Height" value={u.height ? `${u.height} cm` : "—"} />
          <Spec label="Known Issues" value={u.beard === "Full" ? "Bearded" : u.glasses === "Yes" ? "Spectacled" : "None filed"} />
          <Spec label="Operating Environment" value={u.area || "Undisclosed"} />
          <Spec label="Compatibility" value={u.college || "—"} />
          <Spec label="Workplace" value={u.workplace || "—"} />
          <Spec label="Hair" value={u.hair} />
          <Spec label="Glasses" value={u.glasses} />
        </div>

        {!isMe && (
          <div className="mt-5">
            {myRatingOfThem ? (
              <div className="font-mono text-xs text-[#8A8F98] border border-[#2A2E37] rounded-md px-3 py-2 inline-block">YOU HAVE ALREADY JUDGED THIS HUMAN.</div>
            ) : (
              <Btn sounds={sm.sounds} onClick={() => setShowRate(true)}><Gavel size={15} /> Judge This Human</Btn>
            )}
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Btn sounds={sm.sounds} variant="dark" onClick={() => setView("report")}>📊 PERFORMANCE REPORT</Btn>
          {!isMe && <Btn sounds={sm.sounds} variant="dark" onClick={() => setView("compatibility")}>🧬 HUMAN COMPATIBILITY</Btn>}
          {isMe && <Btn sounds={sm.sounds} variant="dark" onClick={() => setView("certificate")}>📜 CERTIFICATE OF HUMANITY</Btn>}
        </div>

        {isMe && (
          <div className="mt-5 flex gap-2">
            <Btn sounds={sm.sounds} variant="ghost" onClick={() => setView("qr")}><QrCode size={15} /> My Human QR</Btn>
            <Btn sounds={sm.sounds} variant="ghost" onClick={() => setView("settings")}><Settings size={15} /> Edit Profile</Btn>
          </div>
        )}
      </div>

      <div className="flex flex-wrap border border-[#2A2E37] rounded-md overflow-hidden mb-4 w-fit">
        <button onClick={() => setTab("overview")} className={`px-4 py-2 text-xs font-mono ${tab === "overview" ? "bg-[#1B1E25]" : "text-[#8A8F98]"}`}>RECEIVED REVIEWS ({receivedReviews.length})</button>
        {isMe && <button onClick={() => setTab("posted")} className={`px-4 py-2 text-xs font-mono ${tab === "posted" ? "bg-[#1B1E25]" : "text-[#8A8F98]"}`}>POSTED BY ME ({postedReviews.length})</button>}
        <button onClick={() => setTab("encounters")} className={`px-4 py-2 text-xs font-mono ${tab === "encounters" ? "bg-[#1B1E25]" : "text-[#8A8F98]"}`}>ENCOUNTERS ({humanEncounters.length})</button>
        <button onClick={() => setTab("breakdown")} className={`px-4 py-2 text-xs font-mono ${tab === "breakdown" ? "bg-[#1B1E25]" : "text-[#8A8F98]"}`}>BREAKDOWN</button>
      </div>

      {tab === "overview" && (
        receivedReviews.length ? (
          <div className="space-y-3">
            {receivedReviews.map((r) => (
              <ReviewCard key={r.id} r={r} isOwner={isMe} me={me} appealRating={appealRating} reportReview={reportReview} notify={notify} sm={sm} />
            ))}
          </div>
        ) : <EmptyState title="NO REVIEWS FILED" sub="This human has not yet been judged." />
      )}
      {tab === "posted" && isMe && (
        postedReviews.length ? (
          <div className="space-y-3">
            {postedReviews.map((r) => {
              const target = users.find((x) => x.id === r.targetId);
              const avg = Object.values(r.categories || {}).reduce((a, v) => a + Number(v || 0), 0) / Math.max(1, Object.keys(r.categories || {}).length);
              return (
                <div key={r.id} className="border border-[#2A2E37] rounded-md p-4 bg-[#14161B]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-[10px] text-[#565B66] mb-1">YOU JUDGED @{target?.nickname || "UNKNOWN HUMAN"}</div>
                      <div className="text-sm">“{r.reviewText}”</div>
                    </div>
                    <div className="font-mono text-xs font-bold shrink-0">{avg.toFixed(1)}/10</div>
                  </div>
                  <div className="font-mono text-[10px] text-[#565B66] mt-2">{new Date(r.createdAt).toLocaleDateString()} · VERDICT FILED</div>
                </div>
              );
            })}
          </div>
        ) : <EmptyState title="NO REVIEWS POSTED" sub="You have not judged another human yet. Your silence is currently suspicious." />
      )}

      {tab === "encounters" && (
        humanEncounters.length ? (
          <div className="space-y-3">
            {humanEncounters.map((e) => {
              const otherId = e.viewerId === u.id ? e.targetId : e.viewerId;
              const other = users.find((x) => x.id === otherId);
              if (!other) return null;
              return (
                <div key={e.id} className="border border-[#2A2E37] rounded-md p-4 bg-[#14161B] flex items-center gap-3 cursor-pointer hover:border-[#565B66]" onClick={() => goProfile(other.id)}>
                  <img src={other.selfie} className="w-10 h-10 rounded-full object-cover" alt="" />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs font-bold">@{other.nickname}</div>
                    <div className="text-[10px] text-[#8A8F98]">HUMAN ENCOUNTER · {new Date(e.createdAt).toLocaleString()}</div>
                  </div>
                  <span className="font-mono text-[10px] text-[#3DDC97]">ENCOUNTER LOGGED</span>
                </div>
              );
            })}
          </div>
        ) : <EmptyState title="NO ENCOUNTERS LOGGED" sub="The system has detected no confirmed human contact yet." />
      )}

      {tab === "breakdown" && (
        <div className="grid sm:grid-cols-2 gap-3">
          {categories.map((c) => {
            const v = stats.breakdown[c.key];
            return (
              <div key={c.key} className="border border-[#2A2E37] rounded-md p-3">
                <div className="flex justify-between text-xs font-mono mb-1">
                  <span>{c.emoji} {c.label}</span><span>{v != null ? v.toFixed(1) : "—"}/10</span>
                </div>
                <div className="h-1.5 bg-[#1B1E25] rounded-full overflow-hidden">
                  <div className="h-full bg-[#FF4D3D]" style={{ width: `${v != null ? v * 10 : 0}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showRate && (
        <RateModal target={u} categories={categories} onClose={() => setShowRate(false)} sm={sm}
          submitJudgement={submitJudgement} notify={notify} />
      )}
    </div>
  );
}
function Spec({ label, value }) {
  return (
    <div className="border border-[#2A2E37] rounded px-2 py-1.5">
      <div className="text-[#565B66] text-[10px]">{label}</div>
      <div className="text-[#EDEBE3] truncate">{value}</div>
    </div>
  );
}

function ReviewCard({ r, isOwner, me, appealRating, reportReview, notify, sm }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(r.appealResult);
  const [showAppealConfirm, setShowAppealConfirm] = useState(false);
  const [showReport, setShowReport] = useState(false);

  useEffect(() => { setResult(r.appealResult); }, [r.appealResult]);

  const doAppeal = async () => {
    setShowAppealConfirm(false);
    setBusy(true);
    sm.sounds.coin();
    try {
      await appealRating(r.id);
      setBusy(false);
    } catch (ex) {
      setBusy(false);
      notify(ex.message, "error");
    }
  };

  if (r.deleted) return null;

  return (
    <div className="border border-[#2A2E37] rounded-md p-4">
      <div className="flex justify-between items-start gap-3">
        <div className="min-w-0">
          <div className="text-sm">{r.reviewText}</div>
          <div className="font-mono text-[10px] text-[#565B66] mt-2">{new Date(r.createdAt).toLocaleDateString()} · ANONYMOUS REVIEWER</div>
        </div>
        <div className="flex gap-1 shrink-0">
          {!isOwner && !showReport && <button onClick={() => setShowReport(true)} className="text-[10px] font-mono text-[#565B66] hover:text-[#FF4D3D]">REPORT</button>}
        </div>
      </div>

      {showReport && <ReportForm onCancel={() => setShowReport(false)} onSubmit={async (reason, details) => { await reportReview(r.id, reason, details); setShowReport(false); notify("REPORT FILED. THE COUNCIL HAS BEEN NOTIFIED."); }} />}

      {isOwner && (
        <div className="mt-3">
          {r.appealUsed || result ? (
            <div className="font-mono text-xs" style={{ color: (result || r.appealResult) === "HEADS" ? "#3DDC97" : "#8A8F98" }}>
              APPEAL RESULT: {result || r.appealResult} — {(result || r.appealResult) === "HEADS" ? "REVIEW DESTROYED" : "REVIEW SURVIVES"}
            </div>
          ) : showAppealConfirm ? (
            <div className="border border-[#FF4D3D55] rounded-md p-3 bg-[#FF4D3D0d]">
              <div className="font-mono text-xs text-[#FF4D3D] font-bold">YOU ARE ABOUT TO CHALLENGE THE WHO_CARES? SYSTEM.</div>
              <div className="font-mono text-[11px] text-[#8A8F98] mt-1">ONE APPEAL REMAINS. THE COURT WILL DECIDE YOUR FATE.</div>
              <div className="flex gap-2 mt-3">
                <Btn sounds={sm.sounds} onClick={doAppeal} disabled={busy}><Dices size={14} /> {busy ? "COURT IN SESSION..." : "ENTER WHO_CARES? COURT"}</Btn>
                <Btn sounds={sm.sounds} variant="ghost" onClick={() => setShowAppealConfirm(false)} disabled={busy}>Cancel</Btn>
              </div>
            </div>
          ) : (
            <Btn sounds={sm.sounds} variant="ghost" onClick={() => setShowAppealConfirm(true)} disabled={busy}>
              <Dices size={14} /> Appeal This Review
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}

function AppealCourt({ court }) {
  if (!court?.open) return null;
  const result = court.result;
  return (
    <div className="fixed inset-0 z-[2000] bg-black/95 flex items-center justify-center p-4 overflow-y-auto" style={{ animation: "courtIn .25s ease" }}>
      <div className="w-full max-w-xl border border-[#3A3E49] rounded-2xl bg-[#0E0F13] shadow-2xl overflow-hidden">
        <div className="border-b border-[#2A2E37] px-5 py-4 text-center">
          <div className="font-mono text-[10px] text-[#565B66] tracking-[.35em]">WHO_CARES?</div>
          <div className="text-2xl sm:text-3xl font-black mt-1">WHO_CARES? COURT</div>
          <div className="font-mono text-xs text-[#8A8F98] mt-1">CASE #{court.caseId}</div>
        </div>
        <div className="p-6 text-center">
          <div className="border border-[#2A2E37] rounded-lg p-4 mb-6 text-left bg-[#14161B]">
            <div className="font-mono text-[10px] text-[#FF4D3D]">EVIDENCE UNDER REVIEW</div>
            <div className="text-sm mt-2">“{court.reviewText}”</div>
          </div>
          {!result && court.stage === "deliberation" && (
            <div style={{ animation: "pulseCourt 1s ease-in-out infinite" }}>
              <Gavel size={42} className="mx-auto text-[#FF4D3D]" />
              <div className="font-mono text-lg font-bold mt-4">THE COURT WILL NOW DELIBERATE</div>
              <div className="font-mono text-xs text-[#8A8F98] mt-2">CONSULTING THE COUNCIL · VERIFYING ABSOLUTELY NOTHING</div>
            </div>
          )}
          {!result && court.stage === "flipping" && (
            <div>
              <div className="relative w-28 h-28 mx-auto mb-6" style={{ perspective: "900px" }}>
                <div className="absolute inset-0 rounded-full border-4 border-[#FFC72C] bg-[#1A1B20] shadow-[0_0_45px_rgba(255,199,44,.35)]" style={{ animation: "courtCoin 2s cubic-bezier(.2,.75,.2,1) infinite" }}>
                  <div className="absolute inset-3 rounded-full border border-[#FFC72C66] flex items-center justify-center font-black text-3xl text-[#FFC72C]">HR</div>
                </div>
              </div>
              <div className="font-mono text-lg font-bold tracking-widest">THE COIN IS IN THE AIR</div>
              <div className="font-mono text-xs text-[#8A8F98] mt-2">NO HUMAN INTERVENTION PERMITTED</div>
            </div>
          )}
          {result && (
            <div style={{ animation: "verdictIn .45s cubic-bezier(.2,.8,.2,1)" }}>
              <div className="font-mono text-[11px] tracking-[.35em] text-[#8A8F98]">FINAL VERDICT</div>
              <div className={`text-6xl sm:text-8xl font-black mt-2 ${result === "HEADS" ? "text-[#3DDC97]" : "text-[#FF4D3D]"}`}>{result}</div>
              <div className="text-xl sm:text-2xl font-black mt-3">{result === "HEADS" ? "JUSTICE HAS PREVAILED." : "YOU HAVE BEEN FOUND ANNOYING."}</div>
              <div className="font-mono text-xs text-[#8A8F98] mt-3">THE COURT HAS SPOKEN. THE DECISION IS FINAL.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReportForm({ onCancel, onSubmit }) {
  const [reason, setReason] = useState("harassment");
  const [details, setDetails] = useState("");
  return (
    <div className="border border-[#2A2E37] rounded-md p-3 mt-3 bg-[#0E0F13]">
      <Field label="REASON">
        <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)}>
          {["harassment", "hate", "sexual content", "threats", "spam", "impersonation", "inappropriate content", "other"].map((o) => <option key={o}>{o}</option>)}
        </select>
      </Field>
      <Field label="DETAILS (optional)"><textarea className={inputCls} rows={2} value={details} onChange={(e) => setDetails(e.target.value)} /></Field>
      <div className="flex gap-2">
        <Btn onClick={() => onSubmit(reason, details)}>Submit Report</Btn>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

/* ---------------- RATE MODAL ---------------- */
function RateModal({ target, categories, onClose, sm, submitJudgement, notify }) {
  const [stage, setStage] = useState("rate");
  const [values, setValues] = useState(() => Object.fromEntries(categories.map((c) => [c.key, 5])));
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [procLine, setProcLine] = useState(0);
  const procLines = ["PROCESSING HUMAN...", "ANALYZING VIBES...", "CALIBRATING AURA...", "DETECTING MAIN CHARACTER SYNDROME...", "CONSULTING THE COUNCIL..."];
  const aura = categories.find((c) => c.key === "aura");
  const subCategories = categories.filter((c) => c.key !== "aura");

  const setRating = (key, value) => setValues((prev) => ({ ...prev, [key]: Number(value) }));

  const submit = async () => {
    setErr("");
    try {
      setStage("processing");
      let i = 0;
      const iv = setInterval(() => { i++; setProcLine(i % procLines.length); }, 500);
      sm.sounds.reveal();
      await submitJudgement(target.id, values, text);
      setTimeout(() => {
        clearInterval(iv);
        setStage("done");
        sm.sounds.verdict();
      }, 2100);
    } catch (ex) {
      setStage("rate"); setErr(ex.message); sm.sounds.error();
    }
  };

  const RatingControl = ({ category, large = false }) => (
    <div className={large ? "border-2 border-[#FF4D3D66] rounded-xl p-5 bg-[#1B1E25]" : "border border-[#2A2E37] rounded-lg p-3 bg-[#14161B]"}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className={`${large ? "text-base" : "text-xs"} font-bold text-[#EDEBE3]`}>
          {category.emoji} {category.label}
        </span>
        <span className={`${large ? "text-2xl" : "text-base"} font-black text-[#FFC72C]`}>
          {values[category.key]}/10
        </span>
      </div>
      {large && (
        <>
          <div className="text-[11px] font-mono text-[#FF4D3D] mb-2 tracking-widest">PRIMARY HUMAN INDEX · AURA™</div>
          <div className="mb-3 rounded-lg border border-[#FF4D3D33] bg-[#0E0F13] p-3">
            <div className="font-black text-sm tracking-wide">{values[category.key] >= 9 ? "REALITY-BENDING AURA" : values[category.key] >= 8 ? "DANGEROUSLY AURA-RICH" : values[category.key] >= 7 ? "HIGH AURA" : values[category.key] >= 5 ? "STANDARD ISSUE HUMAN" : values[category.key] >= 3 ? "LOW AURA" : "AURA UNDER INVESTIGATION"}</div>
            <div className="mt-1 text-[10px] font-mono text-[#8A8F98]">{values[category.key] >= 8 ? "CONFIDENCE EXCEEDS MEASURABLE COMPETENCE." : values[category.key] >= 5 ? "PRESENCE DETECTED WITHIN ACCEPTABLE PARAMETERS." : "NO SIGNIFICANT AURA ACTIVITY DETECTED."}</div>
          </div>
        </>
      )}
      <input
        type="range" min="0" max="10" step="1" value={values[category.key]}
        onChange={(e) => setRating(category.key, e.target.value)}
        className="w-full accent-[#FF4D3D] cursor-pointer"
        aria-label={`${category.label} rating`}
      />
      <div className="flex justify-between text-[10px] font-mono text-[#8A8F98] mt-1">
        <span>0</span><span>5</span><span>10</span>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[900] bg-black/75 overflow-y-auto overscroll-contain">
      <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
        <div className="bg-[#14161B] border border-[#2A2E37] rounded-xl max-w-lg w-full my-4 p-5 text-[#EDEBE3] shadow-2xl" style={{ animation: "popIn .2s ease" }}>
          {stage === "rate" && (
            <>
              <div className="flex justify-between items-center mb-5">
                <div>
                  <h3 className="font-bold text-lg text-[#EDEBE3]">Judge @{target.nickname}</h3>
                  <div className="text-[11px] font-mono text-[#8A8F98] mt-1">RATE THE MAIN AURA FIRST, THEN THE SUB-RATINGS</div>
                </div>
                <button onClick={onClose} className="p-1"><X size={18} className="text-[#8A8F98]" /></button>
              </div>

              {err && <div className="mb-3 text-xs font-mono text-[#FF4D3D]">{err}</div>}

              {aura && (
                <div className="mb-6">
                  <div className="text-[10px] font-mono tracking-widest text-[#FF4D3D] font-bold mb-2">01 · MAIN RATING</div>
                  <RatingControl category={aura} large />
                </div>
              )}

              <div className="mb-5">
                <div className="text-[10px] font-mono tracking-widest text-[#8A8F98] font-bold mb-2">02 · SUB-RATINGS</div>
                <div className="space-y-2">
                  {subCategories.map((c) => <RatingControl key={c.key} category={c} />)}
                </div>
              </div>

              <Field label={`REVIEW (${text.length}/200)`}>
                <textarea
                  className={`${inputCls} !text-[#EDEBE3] placeholder:!text-[#8A8F98] bg-[#0E0F13]`}
                  rows={3} maxLength={200} value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Would be trustworthy with my life. Not with my fries."
                />
              </Field>
              <Btn sounds={sm.sounds} onClick={submit} className="w-full mt-2">SUBMIT JUDGEMENT</Btn>
            </>
          )}

          {stage === "processing" && (
            <div className="py-10 flex flex-col items-center gap-4">
              <div className="w-14 h-14 border-2 border-[#2A2E37] border-t-[#FF4D3D] rounded-full animate-spin" />
              <div className="font-mono text-sm tracking-widest text-[#FF4D3D]">{procLines[procLine]}</div>
            </div>
          )}

          {stage === "done" && (
            <div className="py-8 text-center">
              <Sparkles className="mx-auto mb-3" color="#FFC72C" size={32} />
              <div className="font-mono font-bold text-lg text-[#EDEBE3]">THE VERDICT HAS BEEN RECORDED.</div>
              <div className="text-xs text-[#8A8F98] mt-2">@{target.nickname}'s standing has been updated.</div>
              <Btn sounds={sm.sounds} onClick={onClose} className="mt-5">Done</Btn>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- USELESS SHOWCASE SYSTEMS ---------------- */
function RandomHuman({ users, ratings, categories, me, goProfile, setView, sm }) {
  const candidates = users.filter((u) => u.id !== me.id && u.discoverable && !u.deleted && !u.suspended);
  const [picked, setPicked] = useState(null);
  const [scanning, setScanning] = useState(false);
  const summon = () => {
    if (!candidates.length) return;
    sm.sounds.reveal(); setScanning(true); setPicked(null);
    setTimeout(() => { setPicked(candidates[Math.floor(Math.random()*candidates.length)]); setScanning(false); sm.sounds.found(); }, 1100);
  };
  const stats = picked ? computeStats(picked.id, ratings, categories) : null;
  return <div className="mx-auto max-w-3xl py-8 text-center">
    <div className="font-mono text-[10px] tracking-[.35em] text-[#737984]">RANDOM HUMAN ACQUISITION SYSTEM™</div>
    <h2 className="mt-3 text-4xl font-black">SUMMON RANDOM HUMAN</h2>
    <p className="mx-auto mt-2 max-w-xl text-xs text-[#8A8F98]">There is absolutely no practical reason for this system to exist.</p>
    {!picked && !scanning && <Btn sounds={sm.sounds} onClick={summon} className="mx-auto mt-10 px-8 py-4 text-base"><Zap size={18}/> INITIATE SUMMONING</Btn>}
    {scanning && <div className="mt-14"><Loading lines={["LOCATING SPECIMEN...","ANALYSING VIBES...","CROSS-REFERENCING AURA...","CONSULTING ABSOLUTELY NOTHING..."]}/></div>}
    {picked && stats && <div className="mt-10 rounded-3xl border border-[#2A2E37] bg-[#111318] p-6 text-left shadow-2xl">
      <div className="font-mono text-[10px] tracking-widest text-[#737984]">SPECIMEN LOCATED</div>
      <div className="mt-2 flex flex-col gap-5 sm:flex-row sm:items-center">
        <img src={picked.selfie} className="h-28 w-28 rounded-2xl object-cover border border-[#2A2E37]" alt=""/>
        <div className="flex-1"><div className="text-3xl font-black">@{picked.nickname}</div><div className="mt-1 text-xs text-[#8A8F98]">HUMAN STATUS: OPERATIONAL</div></div>
        <div className="text-center"><div className="text-5xl font-black">{stats.score.toFixed(1)}</div><div className="font-mono text-[9px] text-[#777D87]">AURA INDEX™</div></div>
      </div>
      <div className="mt-6 grid grid-cols-3 gap-2"><ScorePanel label="CHAOS" value={Math.round((stats.score*13)%100)}/><ScorePanel label="BRAIN.EXE" value={Math.round((stats.score*7)%100)}/><ScorePanel label="FOOD SHARING" value={Math.round((stats.score*3)%100)}/></div>
      <div className="mt-5 rounded-2xl border border-[#2A2E37] bg-[#0B0D10] p-5"><div className="font-mono text-[9px] tracking-widest text-[#777D87]">SYSTEM RECOMMENDATION</div><div className="mt-2 text-lg font-black">{stats.score >= 8 ? "MAINTAIN A SAFE CONVERSATIONAL DISTANCE." : "CASUAL HUMAN INTERACTION MAY BE ATTEMPTED."}</div></div>
      <div className="mt-5 flex gap-2"><Btn sounds={sm.sounds} onClick={()=>goProfile(picked.id)} className="flex-1">OPEN HUMAN DOSSIER</Btn><Btn sounds={sm.sounds} variant="ghost" onClick={summon}>SUMMON AGAIN</Btn></div>
    </div>}
    <button onClick={()=>setView("home")} className="mt-8 text-[10px] font-mono text-[#666B75]">← RETURN TO HUMAN SYSTEM</button>
  </div>;
}

function HumanReport({ user, users, ratings, categories, setView, sm }) {
  const stats=computeStats(user.id,ratings,categories); const aura=stats.score||0;
  const auraLabel=aura>=9?"REALITY-BENDING AURA":aura>=8?"DANGEROUSLY AURA-RICH":aura>=7?"HIGH AURA":aura>=5?"STANDARD ISSUE HUMAN":aura>=3?"LOW AURA":"AURA UNDER INVESTIGATION";
  return <div className="mx-auto max-w-4xl py-8"><button onClick={()=>setView("profile")} className="font-mono text-xs text-[#777D87]">← RETURN TO HUMAN DOSSIER</button>
    <div className="mt-5 overflow-hidden rounded-3xl border border-[#2A2E37] bg-[#101216] shadow-2xl"><div className="border-b border-[#2A2E37] p-6"><div className="font-mono text-[9px] tracking-[.35em] text-[#777D87]">HUMAN PERFORMANCE REPORT™ · CONFIDENTIAL</div><h1 className="mt-2 text-3xl font-black">@{user.nickname}</h1><div className="mt-1 text-[10px] font-mono text-[#666B75]">SUBJECT ID: {humanCode(user.id)}</div></div>
      <div className="grid gap-5 p-6 md:grid-cols-[.8fr_1.2fr]"><div className="rounded-2xl border border-[#2A2E37] bg-[#090A0D] p-6 text-center"><div className="font-mono text-[9px] tracking-widest text-[#777D87]">THE HUMAN AURA INDEX™</div><div className="mt-4 text-7xl font-black">{aura.toFixed(1)}</div><div className="mt-2 text-sm font-black">{auraLabel}</div><div className="mt-2 text-[10px] text-[#777D87]">{aura>=8?"CONFIDENCE EXCEEDS MEASURABLE COMPETENCE.":"PRESENCE DETECTED WITHIN ACCEPTABLE PARAMETERS."}</div><div className="mt-5 h-2 rounded-full bg-[#20242C] overflow-hidden"><div className="h-full bg-[#FF4D3D]" style={{width:`${Math.min(100,aura*10)}%`}}/></div></div>
      <div><div className="font-mono text-[9px] tracking-widest text-[#777D87] mb-2">MEASURED HUMAN PARAMETERS</div><div className="grid gap-2 sm:grid-cols-2">{categories.map(c=>{const v=stats.breakdown[c.key];return <ScorePanel key={c.key} label={c.label.toUpperCase()} value={v==null?"—":v.toFixed(1)}/>})}</div><div className="mt-4 rounded-2xl border border-[#2A2E37] bg-[#171A20] p-5"><div className="font-mono text-[9px] tracking-widest text-[#777D87]">AI OBSERVATION</div><div className="mt-2 text-sm font-bold leading-6">“Subject demonstrates {aura>=7?"above-average confidence despite insufficient evidence of competence":"a statistically acceptable level of human activity"}.”</div><div className="mt-3 text-[9px] font-mono text-[#666B75]">RECOMMENDATION: CONTINUE OBSERVING SUBJECT.</div></div></div></div></div>
  </div>;
}

function Compatibility({ me, target, ratings, categories, setView, sm }) {
  const seed=`${me.id}:${target.id}`.split("").reduce((n,c)=>((n*31+c.charCodeAt(0))>>>0),17); const pct=40+(seed%5700)/100;
  return <div className="mx-auto max-w-2xl py-10 text-center"><button onClick={()=>setView("profile")} className="font-mono text-xs text-[#777D87]">← ABORT ANALYSIS</button><div className="mt-8 font-mono text-[9px] tracking-[.35em] text-[#777D87]">INTER-HUMAN COMPATIBILITY ENGINE™</div><h1 className="mt-3 text-4xl font-black">YOU × @{target.nickname}</h1><div className="my-10 text-8xl font-black">{pct.toFixed(2)}<span className="text-3xl">%</span></div><div className="space-y-2 text-left">{[["AURA COMPATIBILITY",pct+17],["CHAOS COMPATIBILITY",pct+29],["BRAIN.EXE COMPATIBILITY",pct+3],["FOOD COMPATIBILITY",pct-11]].map(([k,v])=><div key={k} className="flex justify-between rounded-xl border border-[#2A2E37] bg-[#14161B] p-4 font-mono text-xs"><span>{k}</span><b>{(Math.abs(v)%100).toFixed(0)}%</b></div>)}</div><div className="mt-8 text-xl font-black">{pct>85?"PROCEED. THIS MAY BECOME A PROBLEM.":pct>65?"PROBABLY SAFE. PROBABLY.":"YOU SHOULD PROBABLY NOT BE LEFT ALONE TOGETHER."}</div></div>;
}

function HumanCertificate({ user, ratings, categories, setView }) {
  const stats=computeStats(user.id,ratings,categories); const aura=stats.score||0; const tier=stats.tier==='UNRANKED'?'PROVISIONAL HUMAN':`${stats.tier}-TIER HUMAN`;
  return <div className="mx-auto max-w-3xl py-10"><div className="rounded-3xl border-2 border-[#4A505B] bg-[#111318] p-10 text-center shadow-2xl"><div className="font-mono text-[9px] tracking-[.4em] text-[#777D87]">WHO_CARES?</div><div className="mt-6 text-3xl">✦</div><div className="mt-3 text-xs font-black tracking-widest">CERTIFICATE OF HUMANITY</div><div className="mt-8 text-sm text-[#8A8F98]">This certifies that</div><div className="mt-2 text-5xl font-black">@{user.nickname}</div><div className="mt-7 text-sm">has been professionally evaluated by other humans and has achieved</div><div className="my-7 text-5xl font-black">{tier}</div><div className="mx-auto max-w-md grid grid-cols-2 gap-2 text-left"><ScorePanel label="AURA INDEX™" value={aura.toFixed(2)}/><ScorePanel label="VALIDITY" value="UNKNOWN"/></div><div className="mt-8 text-[9px] font-mono text-[#666B75]">CERTIFICATE VALID UNTIL FURTHER NOTICE · {humanCode(user.id)}</div><Btn onClick={()=>setView("home")} className="mx-auto mt-7">RETURN TO HUMAN SYSTEM</Btn></div></div>;
}

/* ---------------- LEADERBOARD ---------------- */
function Leaderboard({ users, ratings, categories, goProfile, sm }) {
  const [loading, setLoading] = useState(true);
  useEffect(() => { const t = setTimeout(() => { setLoading(false); sm.sounds.tier(); }, 600); return () => clearTimeout(t); }, []);
  const list = users.filter((u) => u.discoverable && !u.deleted && !u.suspended)
    .map((u) => ({ u, stats: computeStats(u.id, ratings, categories) }))
    .filter((x) => x.stats.count >= MIN_REVIEWS_FOR_TIER);

  if (loading) return <Loading lines={["Tabulating humanity...", "Weighing the confidence intervals...", "Preparing the leaderboard reveal..."]} />;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-1">GLOBAL HUMAN RANKINGS™</h2>
      <p className="text-xs text-[#8A8F98] mb-6">The global stock exchange for completely meaningless human statistics.</p>
      {TIERS.map((t) => {
        const rows = list.filter((x) => x.stats.tier === t.key).sort((a, b) => b.stats.score - a.stats.score);
        return (
          <div key={t.key} className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <TierBadge tier={t.key} size="lg" />
              <span className="text-xs font-mono text-[#565B66]">{rows.length} human{rows.length !== 1 ? "s" : ""}</span>
            </div>
            {rows.length ? (
              <div className="space-y-1.5">
                {rows.map((r, i) => (
                  <div key={r.u.id} onClick={() => goProfile(r.u.id)} className="flex items-center gap-3 border border-[#2A2E37] rounded-md px-3 py-2 cursor-pointer hover:border-[#565B66]">
                    <span className="font-mono text-xs text-[#565B66] w-5">{i + 1}</span>
                    <img src={r.u.selfie} className="w-8 h-8 rounded-full object-cover" alt="" />
                    <span className="font-mono text-xs font-bold flex-1 truncate">@{r.u.nickname}</span>
                    <span className="text-xs text-[#8A8F98]">{r.stats.count} reviews</span>
                    <span className="font-bold text-sm">{r.stats.score}</span>
                  </div>
                ))}
              </div>
            ) : <div className="text-xs font-mono text-[#565B66] pl-1">No humans in this tier yet.</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- QR ---------------- */
function QRScreen({ me, users, encounters, persistEncounters, goProfile, notify, sm }) {
  const code = humanCode(me.id);
  const [enterCode, setEnterCode] = useState("");
  const [encounter, setEncounter] = useState(null);
  const [scanning, setScanning] = useState(false);

  const grid = useMemo(() => {
    // deterministic pseudo-QR pattern purely for visual flavor
    let seed = 0; for (let i = 0; i < code.length; i++) seed = (seed * 33 + code.charCodeAt(i)) >>> 0;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    return Array.from({ length: 11 * 11 }, () => rand() > 0.55);
  }, [code]);

  const scan = () => {
    setScanning(true); sm.sounds.click();
    setTimeout(async () => {
      const target = users.find((u) => humanCode(u.id) === enterCode.trim().toUpperCase() && !u.deleted);
      setScanning(false);
      if (!target) { notify("NO HUMAN MATCHES THIS CODE.", "error"); sm.sounds.error(); return; }
      const encounterRecord = { id: crypto.randomUUID(), viewerId: me.id, targetId: target.id, createdAt: Date.now(), code: humanCode(target.id) };
      await persistEncounters([...encounters, encounterRecord]);
      setEncounter(target); sm.sounds.found();
    }, 900);
  };

  return (
    <div className="max-w-md mx-auto">
      <h2 className="text-2xl font-bold mb-1">My Human QR</h2>
      <p className="text-xs text-[#8A8F98] mb-6">Your encounter code. Never reveals your exact location.</p>

      <div className="border border-[#2A2E37] rounded-xl p-6 bg-[#14161B] text-center mb-8">
        <div className="grid grid-cols-11 gap-[2px] w-fit mx-auto mb-4 p-3 bg-white rounded-md">
          {grid.map((on, i) => <div key={i} className="w-2.5 h-2.5" style={{ background: on ? "#0E0F13" : "transparent" }} />)}
        </div>
        <div className="font-mono text-lg font-bold tracking-widest">{code}</div>
        <div className="text-[11px] text-[#565B66] mt-1">@{me.nickname}'s human encounter code</div>
      </div>

      <div className="border border-[#2A2E37] rounded-lg p-4">
        <div className="font-mono text-xs font-bold mb-3">SCAN A HUMAN</div>
        <div className="flex gap-2">
          <input className={inputCls} placeholder="Enter code, e.g. HR-4F9A2B" value={enterCode} onChange={(e) => setEnterCode(e.target.value)} />
          <Btn sounds={sm.sounds} onClick={scan}>Scan</Btn>
        </div>
      </div>

      {scanning && <Loading lines={["Detecting nearby human...", "Verifying encounter code..."]} />}
      {encounter && !scanning && (
        <div className="mt-6 text-center border border-[#3DDC9755] rounded-lg p-6" style={{ animation: "popIn .3s ease" }}>
          <div className="font-mono text-xs text-[#3DDC97] font-bold tracking-widest mb-2">HUMAN ENCOUNTER DETECTED</div>
          <img src={encounter.selfie} className="w-16 h-16 rounded-full object-cover mx-auto mb-2" alt="" />
          <div className="font-bold">You have encountered @{encounter.nickname}.</div>
          <Btn sounds={sm.sounds} onClick={() => goProfile(encounter.id)} className="mt-4"><Gavel size={15} /> Judge This Human</Btn>
        </div>
      )}
    </div>
  );
}

/* ---------------- SETTINGS ---------------- */
function SettingsScreen({ me, updateMe, changePassword, deleteAccount, notify, sm }) {
  const [form, setForm] = useState({ ...me });
  const [oldPw, setOldPw] = useState(""); const [newPw, setNewPw] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    await updateMe({
      college: form.college, workplace: form.workplace, area: form.area, height: form.height,
      beard: form.beard, hair: form.hair, bald: form.bald, glasses: form.glasses,
      discoverable: form.discoverable, showRealName: form.showRealName,
    });
    notify("PROFILE UPDATED.");
  };

  const onSelfie = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { const url = await fileToCompressedDataUrl(f); await updateMe({ selfie: url }); setForm((s) => ({ ...s, selfie: url })); notify("SELFIE REPLACED."); }
    catch (ex) { notify(ex.message, "error"); }
  };

  const doChangePw = async () => {
    setErr("");
    try { await changePassword(oldPw, newPw); setOldPw(""); setNewPw(""); notify("PASSWORD UPDATED."); }
    catch (ex) { setErr(ex.message); }
  };

  return (
    <div className="max-w-xl">
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      <div className="border border-[#2A2E37] rounded-lg p-4 mb-4 flex items-center gap-4">
        <img src={form.selfie} className="w-16 h-16 rounded-full object-cover" alt="" />
        <label className="cursor-pointer">
          <span className="text-xs font-mono px-3 py-1.5 border border-[#2A2E37] rounded-md hover:border-[#565B66]">REPLACE SELFIE</span>
          <input type="file" accept="image/*" className="hidden" onChange={onSelfie} />
        </label>
      </div>

      <div className="border border-[#2A2E37] rounded-lg p-4 mb-4">
        <div className="font-mono text-xs font-bold mb-3">EDIT SPEC SHEET</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="COLLEGE"><input className={inputCls} value={form.college} onChange={(e) => setForm({ ...form, college: e.target.value })} /></Field>
          <Field label="WORKPLACE"><input className={inputCls} value={form.workplace} onChange={(e) => setForm({ ...form, workplace: e.target.value })} /></Field>
          <Field label="HEIGHT"><input className={inputCls} value={form.height} onChange={(e) => setForm({ ...form, height: e.target.value })} /></Field>
          <Field label="AREA"><input className={inputCls} value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} /></Field>
          <Field label="BEARD"><select className={inputCls} value={form.beard} onChange={(e) => setForm({ ...form, beard: e.target.value })}>{["None", "Stubble", "Full"].map((o) => <option key={o}>{o}</option>)}</select></Field>
          <Field label="GLASSES"><select className={inputCls} value={form.glasses} onChange={(e) => setForm({ ...form, glasses: e.target.value })}>{["No", "Yes"].map((o) => <option key={o}>{o}</option>)}</select></Field>
        </div>
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input type="checkbox" checked={form.showRealName} onChange={(e) => setForm({ ...form, showRealName: e.target.checked })} />
          <span className="text-xs font-mono text-[#8A8F98]">Show my real name on my profile (optional)</span>
        </label>
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input type="checkbox" checked={form.discoverable} onChange={(e) => setForm({ ...form, discoverable: e.target.checked })} />
          <span className="text-xs font-mono text-[#8A8F98]">Discoverable in search & leaderboard</span>
        </label>
        <Btn sounds={sm.sounds} onClick={save} className="mt-4">Save Changes</Btn>
      </div>

      <div className="border border-[#2A2E37] rounded-lg p-4 mb-4">
        <div className="font-mono text-xs font-bold mb-3">CHANGE PASSWORD</div>
        {err && <div className="text-xs font-mono text-[#FF4D3D] mb-2">{err}</div>}
        <Field label="CURRENT PASSWORD"><input type="password" className={inputCls} value={oldPw} onChange={(e) => setOldPw(e.target.value)} /></Field>
        <Field label="NEW PASSWORD"><input type="password" className={inputCls} value={newPw} onChange={(e) => setNewPw(e.target.value)} /></Field>
        <Btn sounds={sm.sounds} variant="ghost" onClick={doChangePw}>Update Password</Btn>
      </div>

      <div className="border border-[#2A2E37] rounded-lg p-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          {sm.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />} Sound Effects
        </div>
        <Btn sounds={sm.sounds} variant="ghost" onClick={sm.toggle}>{sm.enabled ? "ON" : "OFF"}</Btn>
      </div>

      <div className="border border-[#FF4D3D33] rounded-lg p-4 mt-6">
        <div className="font-mono text-xs font-bold text-[#FF4D3D] mb-2">DANGER ZONE</div>
        <div className="text-xs text-[#8A8F98] mb-3">Deactivating removes your profile from search, leaderboard and discovery. Reviews you received stay on record, anonymized. This cannot be undone from this UI.</div>
        {!confirmDelete ? (
          <Btn variant="ghost" onClick={() => setConfirmDelete(true)} className="border-[#FF4D3D55] text-[#FF4D3D]">Deactivate Account</Btn>
        ) : (
          <div className="flex gap-2">
            <Btn onClick={deleteAccount}>Yes, deactivate me</Btn>
            <Btn variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- ADMIN ---------------- */
function AdminScreen({ users, ratings, reports, categories, adminDeleteRating, adminSuspend, adminCloseReport, goProfile }) {
  const [tab, setTab] = useState("stats");
  const activeUsers = users.filter((u) => !u.deleted);
  const openReports = reports.filter((r) => r.status === "open");

  return (
    <div>
      <div className="flex items-center gap-2 mb-1"><Shield size={20} color="#FF4D3D" /><h2 className="text-2xl font-bold">Council Chambers</h2></div>
      <p className="text-xs text-[#8A8F98] mb-6">Admin-only. Not visible to regular humans.</p>

      <div className="flex border border-[#2A2E37] rounded-md overflow-hidden mb-5 w-fit">
        {["stats", "users", "reviews", "reports"].map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-xs font-mono uppercase ${tab === t ? "bg-[#1B1E25]" : "text-[#8A8F98]"}`}>{t}</button>
        ))}
      </div>

      {tab === "stats" && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <ScorePanel label="TOTAL HUMANS" value={activeUsers.length} />
          <ScorePanel label="TOTAL JUDGEMENTS" value={ratings.filter((r) => !r.deleted).length} />
          <ScorePanel label="OPEN REPORTS" value={openReports.length} />
          <ScorePanel label="APPEALS FILED" value={ratings.filter((r) => r.appealUsed).length} />
        </div>
      )}

      {tab === "users" && (
        <div className="space-y-2">
          {activeUsers.map((u) => (
            <div key={u.id} className="flex items-center gap-3 border border-[#2A2E37] rounded-md px-3 py-2">
              <img src={u.selfie} className="w-8 h-8 rounded-full object-cover cursor-pointer" onClick={() => goProfile(u.id)} alt="" />
              <span className="font-mono text-xs font-bold flex-1">@{u.nickname}</span>
              {u.suspended && <span className="text-[10px] font-mono text-[#FF4D3D]">SUSPENDED</span>}
              <Btn variant={u.suspended ? "primary" : "ghost"} onClick={() => adminSuspend(u.id, !u.suspended)} className="text-[10px] px-2 py-1">
                {u.suspended ? "Reinstate" : "Suspend"}
              </Btn>
            </div>
          ))}
        </div>
      )}

      {tab === "reviews" && (
        <div className="space-y-2">
          {ratings.filter((r) => !r.deleted).sort((a, b) => b.createdAt - a.createdAt).map((r) => {
            const target = users.find((u) => u.id === r.targetId);
            return (
              <div key={r.id} className="border border-[#2A2E37] rounded-md px-3 py-2">
                <div className="text-xs font-mono text-[#8A8F98]">on @{target?.nickname || "unknown"}</div>
                <div className="text-sm">{r.reviewText}</div>
                <Btn variant="ghost" onClick={() => adminDeleteRating(r.id)} className="text-[10px] px-2 py-1 mt-2 border-[#FF4D3D55] text-[#FF4D3D]">Remove Review</Btn>
              </div>
            );
          })}
        </div>
      )}

      {tab === "reports" && (
        openReports.length ? (
          <div className="space-y-2">
            {openReports.map((rep) => {
              const rating = ratings.find((r) => r.id === rep.ratingId);
              return (
                <div key={rep.id} className="border border-[#2A2E37] rounded-md px-3 py-2">
                  <div className="text-xs font-mono text-[#FF9F4D] uppercase">{rep.reason}</div>
                  {rating && <div className="text-sm mt-1">"{rating.reviewText}"</div>}
                  {rep.details && <div className="text-xs text-[#8A8F98] mt-1">{rep.details}</div>}
                  <div className="flex gap-2 mt-2">
                    {rating && !rating.deleted && <Btn variant="ghost" onClick={() => adminDeleteRating(rating.id)} className="text-[10px] px-2 py-1 border-[#FF4D3D55] text-[#FF4D3D]">Remove Review</Btn>}
                    <Btn variant="ghost" onClick={() => adminCloseReport(rep.id)} className="text-[10px] px-2 py-1">Dismiss</Btn>
                  </div>
                </div>
              );
            })}
          </div>
        ) : <EmptyState title="NO OPEN REPORTS" sub="The council has no business today." />
      )}
    </div>
  );
}

/* ---------------- SEED DATA ---------------- */
function pixel(seedStr, bg, fg) {
  let seed = 0; for (let i = 0; i < seedStr.length; i++) seed = (seed * 33 + seedStr.charCodeAt(i)) >>> 0;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const size = 12; let cells = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (rand() > 0.5) cells += `<rect x="${x * 10}" y="${y * 10}" width="10" height="10" fill="${fg}"/>`;
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><rect width='120' height='120' fill='${bg}'/>${cells}</svg>`;
  return "data:image/svg+xml;base64," + btoa(svg);
}
async function seedUsers() {
  const palette = ["#FF4D3D", "#3DDC97", "#4DA3FF", "#B98CFF", "#FF9F4D", "#FFC72C"];
  const names = ["arjun.exe", "meera_404", "rahul.exe", "priya_ok", "kiran.dev", "nandini_x", "vishnu007", "ananya.zip", "sarath_yo", "divya.exe"];
  const colleges = ["MIT College of Engineering", "St. Xavier's", "IIT Placeholder", "Amrita School of Eng", "Local Poly College"];
  const areas = ["Kochi, Ernakulam", "Trivandrum City", "Kozhikode Beach", "Kottayam Town", "Thrissur Pooram District"];
  const passwordHash = await sha256("password123::hr-salt");
  const adminHash = await sha256("admin1234::hr-salt");
  const users = names.map((n, i) => ({
    id: crypto.randomUUID(), nickname: n, email: `${n.replace(/[._]/g, "")}@example.com`,
    passwordHash, realName: `Seed Human ${i + 1}`, showRealName: false,
    gender: ["Male", "Female", "Non-binary"][i % 3], height: 160 + (i % 6) * 5,
    beard: ["None", "Stubble", "Full"][i % 3], hair: ["Short", "Medium", "Long", "Bald"][i % 4],
    bald: i % 4 === 3 ? "Yes" : "No", glasses: i % 2 === 0 ? "Yes" : "No",
    college: colleges[i % colleges.length], workplace: i % 2 === 0 ? "" : "Startup #" + i,
    area: areas[i % areas.length], selfie: pixel(n, "#1B1E25", palette[i % palette.length]),
    discoverable: true, isAdmin: false, suspended: false, deleted: false, createdAt: Date.now() - i * 86400000,
  }));
  users.push({
    id: crypto.randomUUID(), nickname: "admin", email: "admin@who-cares.local", passwordHash: adminHash,
    realName: "System Administrator", showRealName: false, gender: "Unspecified", height: "", beard: "None",
    hair: "Short", bald: "No", glasses: "No", college: "", workplace: "The Council", area: "Undisclosed",
    selfie: pixel("admin", "#0E0F13", "#FF4D3D"), discoverable: false, isAdmin: true, suspended: false, deleted: false, createdAt: Date.now(),
  });
  return users;
}
function seedRatings(users) {
  const humans = users.filter((u) => !u.isAdmin);
  const reviews = [
    "Would be trustworthy with my life. Not with my fries.",
    "Talks for 20 minutes to explain a 5-second story.",
    "Human appears functional but occasionally experiences brain.exe crashes.",
    "Solid Wi-Fi password energy. Would not betray under interrogation.",
    "Red flag density is concerning but the vibes are immaculate.",
    "Certified NPC. Repeats the same three sentences on loop.",
    "Main character energy, questionable plot armor.",
    "Would survive a zombie apocalypse purely by accident.",
    "Screenshot risk: extremely high. Text with caution.",
    "10/10 would share fries. 3/10 would trust with secrets.",
  ];
  const ratings = [];
  humans.forEach((target, ti) => {
    const reviewerCount = 4 + (ti % 5); // 4-8 reviews per seed human
    for (let i = 0; i < reviewerCount; i++) {
      const reviewer = humans[(ti + i + 1) % humans.length];
      if (reviewer.id === target.id) continue;
      const cats = {};
      CATEGORY_DEFAULTS.forEach((c, ci) => {
        cats[c.key] = Math.max(0, Math.min(10, Math.round((3 + ((ti * 3 + i * 2 + ci) % 8)))));
      });
      ratings.push({
        id: crypto.randomUUID(), reviewerId: reviewer.id, targetId: target.id, categories: cats,
        reviewText: reviews[(ti + i) % reviews.length], createdAt: Date.now() - (ti * 5 + i) * 3600000,
        appealUsed: false, appealResult: null, deleted: false,
      });
    }
  });
  return ratings;
}
