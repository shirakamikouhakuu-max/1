const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");

/* ================== HOST KEY ================== */
const HOST_KEY = process.env.HOST_KEY || "CHANGE_ME_HOST_KEY";
const HOST_COOKIE_NAME = "host_auth";

function hostSig() {
  return crypto.createHmac("sha256", HOST_KEY).update("host-ok").digest("hex");
}

function parseCookies(cookieHeader = "") {
  const out = {};
  cookieHeader.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function hasHostCookie(req) {
  const c = parseCookies(req.headers.cookie || "");
  return c[HOST_COOKIE_NAME] === hostSig();
}

function setHostCookie(req, res) {
  const isHttps =
    req.secure ||
    (req.headers["x-forwarded-proto"] || "").toString().includes("https");

  const parts = [
    `${HOST_COOKIE_NAME}=${encodeURIComponent(hostSig())}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000"
  ];
  if (isHttps) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearHostCookie(req, res) {
  const isHttps =
    req.secure ||
    (req.headers["x-forwarded-proto"] || "").toString().includes("https");

  const parts = [
    `${HOST_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (isHttps) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function requireHost(req, res, next) {
  if (hasHostCookie(req)) return next();
  return res.redirect("/host-login");
}

/* ================== QUIZ CONFIG ================== */
const PRE_DELAY_MS = 500;      // chuẩn bị 0.5s
const POPUP_SHOW_MS = 7000;    // popup top5 hiện 7s
const MAX_POINTS = 1000;

const QUIZ = {
  title: "Quiz Realtime – 22s + Nhạc Olympia + Popup Top 5",
  questions: [
    {
      text: "1) Thủ đô của Việt Nam là gì?",
      choices: ["TP.HCM", "Hà Nội", "Đà Nẵng", "Huế"],
      correctIndex: 1,
      timeLimitSec: 22
    },
    {
      text: "2) 5 x 6 = ?",
      choices: ["11", "25", "30", "56"],
      correctIndex: 2,
      timeLimitSec: 22
    },
    {
      text: "3) Biển Đông tiếng Anh là gì?",
      choices: ["East Sea", "Red Sea", "Black Sea", "Yellow Sea"],
      correctIndex: 0,
      timeLimitSec: 22
    }
  ]
};

function computePoints({ correct, elapsedMs, limitSec }) {
  if (!correct) return 0;
  const limitMs = limitSec * 1000;
  const t = Math.max(0, Math.min(1, elapsedMs / limitMs));
  const pts = Math.round(MAX_POINTS * (1 - t));
  return Math.max(1, pts);
}

/* ================== APP ================== */
const app = express();
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));

app.use("/audio", express.static(path.join(__dirname, "public", "audio"), { maxAge: "7d" }));
app.use("/img", express.static(path.join(__dirname, "public", "img"), { maxAge: "7d" }));

const server = http.createServer(app);
const io = new Server(server);

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const rooms = new Map();

function publicState(room) {
  return {
    code: room.code,
    started: room.started,
    ended: room.ended,
    qIndex: room.qIndex,
    total: QUIZ.questions.length
  };
}

function safeQuestionPayload(room) {
  const q = QUIZ.questions[room.qIndex];
  return {
    qIndex: room.qIndex,
    total: QUIZ.questions.length,
    text: q.text,
    choices: q.choices,
    timeLimitSec: q.timeLimitSec,
    startedAtMs: room.qStartAtMs,
    serverNowMs: Date.now(),
    preDelayMs: PRE_DELAY_MS
  };
}

function getTotalLeaderboard(room) {
  const list = [];
  for (const [sid, p] of room.players.entries()) {
    list.push({ socketId: sid, name: p.name, score: p.score });
  }
  list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return list;
}

function getFastCorrectTop5(room) {
  const arr = [];
  for (const p of room.players.values()) {
    const a = p.lastAnswer;
    if (a && a.qIndex === room.qIndex && a.correct) {
      arr.push({ name: p.name, elapsedMs: a.elapsedMs, points: a.points });
    }
  }
  arr.sort((x, y) => x.elapsedMs - y.elapsedMs || y.points - x.points || x.name.localeCompare(y.name));
  return arr.slice(0, 5);
}

function broadcast(room) {
  io.to(room.code).emit("room:state", publicState(room));
}

function startQuestion(room) {
  if (room.timer) clearTimeout(room.timer);

  room.qStartAtMs = Date.now() + PRE_DELAY_MS;

  for (const p of room.players.values()) p.lastAnswer = null;

  io.to(room.code).emit("question:start", safeQuestionPayload(room));

  const q = QUIZ.questions[room.qIndex];
  room.timer = setTimeout(() => endQuestion(room), PRE_DELAY_MS + q.timeLimitSec * 1000);

  broadcast(room);
}

function endQuestion(room) {
  if (room.ended) return;

  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }

  const q = QUIZ.questions[room.qIndex];
  const totalTop15 = getTotalLeaderboard(room).slice(0, 15);
  const fastTop5 = getFastCorrectTop5(room);

  io.to(room.code).emit("question:end", {
    qIndex: room.qIndex,
    correctIndex: q.correctIndex,
    totalTop15,
    fastTop5,
    popupShowMs: POPUP_SHOW_MS
  });

  broadcast(room);
}

function endGame(room) {
  room.ended = true;
  if (room.timer) clearTimeout(room.timer);

  const total = getTotalLeaderboard(room);
  io.to(room.code).emit("game:end", {
    totalTop15: total.slice(0, 15),
    totalPlayers: total.length
  });

  broadcast(room);
}

/* ================== HTML LAYOUT (Splash + Nhạc Splash nghe được) ================== */
function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>

<script>
(function(){
  try{
    var KEY = 'splash_seen_session_v1'; // chỉ 1 lần trong 1 tab
    if (sessionStorage.getItem(KEY) === '1') {
      document.documentElement.classList.add('splash-seen');
    }
  }catch(e){}
})();
</script>

<style>
:root{--bg:#0b1020;--text:#e7ecff;--muted:#a9b3d9;--line:#23305c;--btn:#2d3a6b;--btn2:#1f2a53;--good:#37d67a;--bad:#ff5a5f}
*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
body{margin:0;background:radial-gradient(1200px 800px at 20% 10%, #1a2550 0%, var(--bg) 55%);color:var(--text)}
a{color:var(--text);text-decoration:none}
.container{max-width:980px;margin:0 auto;padding:24px}
.header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:22px}
.card{background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:0 8px 30px rgba(0,0,0,.25)}
.grid{display:grid;grid-template-columns:1fr;gap:16px;margin-top:16px}
@media(min-width:860px){.grid{grid-template-columns:1fr 1fr}}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
label{font-size:13px;color:var(--muted)}
input{width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:rgba(0,0,0,.18);color:var(--text);outline:none}
.btn{padding:10px 14px;border-radius:12px;border:1px solid var(--line);background:var(--btn);color:var(--text);cursor:pointer;font-weight:800}
.btn:hover{background:var(--btn2)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.small{font-size:12px;color:var(--muted)}
.bigcode{font-size:28px;letter-spacing:3px;font-weight:900}
.pill{display:inline-flex;align-items:center;gap:8px;padding:7px 10px;border-radius:999px;border:1px solid var(--line);background:rgba(0,0,0,.14);color:var(--muted);font-size:12px}
.dot{width:8px;height:8px;border-radius:999px;background:var(--muted);display:inline-block}
.dot.good{background:var(--good)} .dot.bad{background:var(--bad)}
hr{border:0;border-top:1px solid var(--line);margin:14px 0}
.choices{display:grid;grid-template-columns:1fr;gap:10px;margin-top:10px}
@media(min-width:720px){.choices{grid-template-columns:1fr 1fr}}

.choice{
  display:flex;align-items:center;gap:12px;
  padding:14px 14px;border-radius:14px;
  border:1px solid rgba(255,255,255,.32);
  background:#1b263b;color:#fff;
  cursor:pointer;text-align:left;
  transition:filter .15s ease, transform .05s ease;
}
.choice:hover{ filter:brightness(1.08); }
.choice:active{ transform:translateY(1px); }
.choice[disabled]{opacity:.78;cursor:not-allowed;filter:none;}
.choice .opt{
  width:34px;height:34px;border-radius:10px;
  display:flex;align-items:center;justify-content:center;
  font-weight:900;letter-spacing:.5px;
  background:rgba(231,236,255,.95);color:#0b1020;
  border:1px solid rgba(0,0,0,.18);flex:0 0 auto
}
.choice .txt{flex:1;font-weight:700;line-height:1.25;color:#fff}

.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);background:rgba(0,0,0,.14);color:var(--muted)}
.good{color:var(--good)} .bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;margin-top:10px}
th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;font-size:14px}
th{color:var(--muted);font-weight:800}

.overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;padding:16px;z-index:9999}
.modal{max-width:720px;width:100%}

/* timer quanh khung */
.qaCard{ position:relative; overflow:hidden; }
.timer-svg{ position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.timer-track{ fill:none; stroke:rgba(255,255,255,.18); stroke-width:6; }
.timer-prog{
  fill:none; stroke:rgba(255, 215, 0, .95); stroke-width:6;
  stroke-linecap:round; stroke-linejoin:round;
  opacity:0;
}

/* splash */
.splash{
  position:fixed; inset:0;
  background:#000;
  display:flex; align-items:center; justify-content:center;
  z-index:999999;
  padding:0;
}
.splash img{ width:100%; height:100%; object-fit:cover; display:block; }
.splash.hide{ opacity:0; pointer-events:none; transition:opacity .45s ease; }
.splash-hint{
  position:fixed;
  bottom:14px; left:50%;
  transform:translateX(-50%);
  background:rgba(0,0,0,.55);
  border:1px solid rgba(255,255,255,.25);
  color:#fff;
  padding:6px 10px;
  border-radius:999px;
  font-size:12px;
  z-index:1000000;
}

/* ✅ chống nháy + chỉ hiện splash 1 lần */
.container{ visibility:hidden; }
.splash-seen .container{ visibility:visible; }
.splash-seen #splash{ display:none !important; }
</style>
</head>
<body>

<div id="splash" class="splash">
  <img src="/img/splash.png" alt="Splash"/>
  <div id="splashHint" class="splash-hint">Bấm để vào</div>

  <audio id="splashAudio" preload="auto" loop playsinline>
    <source src="/audio/splash.mp3" type="audio/mpeg">
  </audio>
</div>

<script src="/socket.io/socket.io.js"></script>
<div class="container">${bodyHtml}</div>

<script>
(function(){
  var splash = document.getElementById('splash');
  if(!splash) return;

  if (document.documentElement.classList.contains('splash-seen')) return;

  var hint = document.getElementById('splashHint');
  var audio = document.getElementById('splashAudio');
  var audioStarted = false;

  function stopSplashAudio(){
    if (!audio) return;
    try{
      audio.pause();
      audio.currentTime = 0;
    }catch(e){}
  }

  // thử autoplay (có thể bị chặn)
  if (audio) {
    try {
      audio.volume = 1.0;
      var p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(function(){ audioStarted = true; })
         .catch(function(){ audioStarted = false; });
      }
    } catch(e){}
  }

  function hideSplash(){
    try{ sessionStorage.setItem('splash_seen_session_v1', '1'); }catch(e){}
    stopSplashAudio();
    document.documentElement.classList.add('splash-seen');
    splash.classList.add('hide');
    setTimeout(function(){ if(splash) splash.remove(); }, 500);
  }

  // ✅ Click:
  // - nếu chưa bật được nhạc: click lần 1 để bật nhạc (không tắt splash)
  // - nếu đã bật nhạc: click lần 2 tắt nhạc + tắt splash
  splash.addEventListener('click', function(){
    if (!audio) return hideSplash();

    if (!audioStarted) {
      audio.play().then(function(){
        audioStarted = true;
        if (hint) hint.textContent = "Nhạc đã bật ✅ Bấm lần nữa để vào";
      }).catch(function(){
        if (hint) hint.textContent = "Trình duyệt đang chặn âm thanh. Hãy bật âm lượng rồi bấm lại.";
      });
      return;
    }

    hideSplash();
  });
})();
</script>

</body>
</html>`;
}

/* ================== ROUTES ================== */
app.get("/health", (_, res) => res.json({ ok: true, preDelayMs: PRE_DELAY_MS }));

app.get("/", (_, res) => {
  res.send(layout("Quiz Realtime", `
    <div class="card">
      <div class="header">
        <h1>${QUIZ.title}</h1>
      </div>
      <p class="small" style="margin:10px 0 0">
        Người chơi vào <b>/play</b>. Host cần key vào <b>/host</b>.
      </p>
      <hr/>
      <div class="row">
        <a class="btn" href="/play">Người chơi</a>
        <a class="btn" href="/host">Host (cần key)</a>
      </div>
    </div>
  `));
});

app.get("/host-login", (req, res) => {
  res.send(layout("Nhập Host Key", `
    <div class="card">
      <h1>Nhập Host Key</h1>
      <p class="small">Chỉ người có key mới vào được trang Host.</p>
      <form method="POST" action="/host-login">
        <label>Host Key</label>
        <input name="key" placeholder="Nhập key..." />
        <div class="row" style="margin-top:10px">
          <button class="btn" type="submit">Vào Host</button>
          <a class="btn" href="/play">Tôi là người chơi</a>
        </div>
      </form>
      <hr/>
      <p class="small">Vào nhanh: <b>/host?key=YOUR_KEY</b></p>
    </div>
  `));
});

app.post("/host-login", (req, res) => {
  const key = String(req.body.key || "").trim();
  if (!key || key !== HOST_KEY) {
    return res.send(layout("Sai Host Key", `
      <div class="card">
        <h1 class="bad">Sai Host Key</h1>
        <p class="small">Vui lòng thử lại.</p>
        <div class="row">
          <a class="btn" href="/host-login">Nhập lại</a>
          <a class="btn" href="/play">Tôi là người chơi</a>
        </div>
      </div>
    `));
  }
  setHostCookie(req, res);
  return res.redirect("/host");
});

app.get("/host-logout", (req, res) => {
  clearHostCookie(req, res);
  return res.redirect("/play");
});

app.get("/host", (req, res, next) => {
  const k = String(req.query.key || "").trim();
  if (k && k === HOST_KEY) {
    setHostCookie(req, res);
    return res.redirect("/host");
  }
  return next();
}, requireHost, (req, res) => {
  res.send(layout("Host", `
    <div class="header">
      <h1>Host (MC)</h1>
      <div class="row">
        <a class="pill" href="/play">Mở trang Người chơi</a>
        <a class="pill" href="/host-logout">Đăng xuất Host</a>
        <button id="soundBtn" class="pill" style="display:none;background:transparent;cursor:pointer">🔊 Bật âm thanh</button>
        <span class="pill"><span class="dot" id="connDot"></span><span id="connText">Đang kết nối…</span></span>
      </div>
    </div>

    <audio id="qAudio" preload="auto" src="/audio/olympia.mp3"></audio>

    <div class="grid">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div>
            <div class="small">Mã phòng</div>
            <div id="roomCode" class="bigcode">—</div>
            <div class="small">Prep <b>0.5s</b> → timer viền chạy <b>22s</b> (không hiện giây).</div>
          </div>
          <div class="row">
            <span class="pill">Người chơi: <b id="playersCount">0</b></span>
            <span class="pill">Câu: <b id="qCounter">—</b></span>
          </div>
        </div>
        <hr/>
        <div class="row">
          <button id="btnCreate" class="btn" disabled>Tạo phòng</button>
          <button id="btnStart" class="btn" disabled>Bắt đầu</button>
          <button id="btnReveal" class="btn" disabled>Kết thúc câu</button>
          <button id="btnNext" class="btn" disabled>Câu tiếp theo</button>
        </div>
      </div>

      <div id="qaCardHost" class="card qaCard">
        <div class="small">Câu hỏi đang chạy</div>
        <h2 id="qText" style="margin:6px 0 0;font-size:18px">—</h2>
        <div class="row" style="margin-top:8px">
          <span class="badge">Đã trả lời: <b id="qAnswered">0</b></span>
        </div>
        <div id="choicesHost" class="choices"></div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="small">Bảng xếp hạng tổng điểm</div>
      <h2 style="margin:6px 0 0;font-size:18px">Top 15 (tích lũy)</h2>
      <table>
        <thead><tr><th>#</th><th>Tên</th><th>Tổng điểm</th></tr></thead>
        <tbody id="lbBody"><tr><td colspan="3" class="small">Chưa có dữ liệu.</td></tr></tbody>
      </table>
    </div>

    <div id="fastPopup" class="overlay">
      <div class="modal card">
        <div class="header">
          <h1 style="font-size:18px;margin:0">Top 5 đúng & nhanh (câu vừa xong)</h1>
          <span class="pill"><span class="small">Tự tắt sau 7 giây</span></span>
        </div>
        <table>
          <thead><tr><th>#</th><th>Tên</th><th>Thời gian</th><th>+Điểm</th></tr></thead>
          <tbody id="fastBody"></tbody>
        </table>
      </div>
    </div>

    <script>
      var socket = io();
      var $ = function(id){ return document.getElementById(id); };
      var esc = function(s){
        return String(s).replace(/[&<>"']/g, function(m){
          return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]);
        });
      };
      function fmtMs(ms){ return (ms/1000).toFixed(2) + "s"; }

      var ANSWER_COLOR_POOL = ["#1D3557","#0B3D91","#264653","#283618","#2F3E46","#3A0CA3","#5A189A","#6A040F","#004E64","#1B263B","#2D1E2F","#006D77"];
      function shuffle(arr){
        var a = arr.slice();
        for (var i = a.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
      }
      function pickAnswerColors(n){
        var pool = shuffle(ANSWER_COLOR_POOL);
        while (pool.length < n) pool = pool.concat(shuffle(ANSWER_COLOR_POOL));
        return pool.slice(0, n);
      }
      function applyAnswerColors(containerId){
        var wrap = $(containerId);
        if (!wrap) return;
        var nodes = wrap.querySelectorAll(".choice");
        var colors = pickAnswerColors(nodes.length);
        nodes.forEach(function(node, idx){
          node.style.background = colors[idx];
          node.style.borderColor = "rgba(255,255,255,.32)";
        });
      }

      function ensureTimer(cardId){
        var card = $(cardId);
        if (!card) return null;
        if (card.__timerObj) return card.__timerObj;

        var ns = "http://www.w3.org/2000/svg";
        var svg = document.createElementNS(ns, "svg");
        svg.setAttribute("class", "timer-svg");

        var track = document.createElementNS(ns, "rect");
        track.setAttribute("class", "timer-track");

        var prog = document.createElementNS(ns, "rect");
        prog.setAttribute("class", "timer-prog");

        svg.appendChild(track);
        svg.appendChild(prog);
        card.appendChild(svg);

        var obj = { card: card, svg: svg, track: track, prog: prog, len: 0, raf: 0 };

        obj.resize = function(){
          var w = card.clientWidth;
          var h = card.clientHeight;
          var sw = 6;
          var r = 16;
          var rx = Math.max(0, r - sw/2);

          svg.setAttribute("viewBox", "0 0 " + w + " " + h);

          track.setAttribute("x", sw/2);
          track.setAttribute("y", sw/2);
          track.setAttribute("width", Math.max(0, w - sw));
          track.setAttribute("height", Math.max(0, h - sw));
          track.setAttribute("rx", rx);
          track.setAttribute("ry", rx);

          prog.setAttribute("x", sw/2);
          prog.setAttribute("y", sw/2);
          prog.setAttribute("width", Math.max(0, w - sw));
          prog.setAttribute("height", Math.max(0, h - sw));
          prog.setAttribute("rx", rx);
          prog.setAttribute("ry", rx);

          try{
            obj.len = prog.getTotalLength();
            prog.style.strokeDasharray = String(obj.len);
          }catch(e){}
        };

        window.addEventListener("resize", function(){ obj.resize(); });
        obj.resize();

        card.__timerObj = obj;
        return obj;
      }

      function startTimer(cardId, startAtMs, durationMs){
        var t = ensureTimer(cardId);
        if (!t || !t.len) return;

        t.resize();
        if (t.raf) cancelAnimationFrame(t.raf);

        var len = t.len;
        t.prog.style.opacity = "1";
        t.prog.style.strokeDasharray = String(len);
        t.prog.style.strokeDashoffset = String(len);

        function step(){
          var now = Date.now();
          var p = (now - startAtMs) / durationMs;

          if (p < 0) {
            t.prog.style.strokeDashoffset = String(len);
            t.raf = requestAnimationFrame(step);
            return;
          }

          p = Math.max(0, Math.min(1, p));
          t.prog.style.strokeDashoffset = String(len * (1 - p));
          if (p < 1) t.raf = requestAnimationFrame(step);
        }
        t.raf = requestAnimationFrame(step);
      }

      function stopTimer(cardId){
        var t = ensureTimer(cardId);
        if (!t) return;
        if (t.raf) cancelAnimationFrame(t.raf);
        t.raf = 0;
        t.prog.style.opacity = "0";
      }

      var audio = document.getElementById("qAudio");
      var soundBtn = document.getElementById("soundBtn");
      function stopAudio(){ try{ audio.pause(); audio.currentTime = 0; }catch(e){} }
      function playAudioAfter(delayMs){
        stopAudio();
        soundBtn.style.display = "none";
        setTimeout(function(){
          audio.play().catch(function(){ soundBtn.style.display = "inline-flex"; });
        }, delayMs);
      }
      soundBtn.onclick = function(){ audio.play().then(function(){ soundBtn.style.display = "none"; }).catch(function(){}); };

      var dot = document.getElementById("connDot");
      var text = document.getElementById("connText");
      function setConn(ok, msg){
        dot.classList.remove("good","bad");
        dot.classList.add(ok ? "good" : "bad");
        text.textContent = msg;
      }

      var code = null;
      var state = null;

      var popupTimer = null;
      function hidePopup(){ document.getElementById("fastPopup").style.display = "none"; }
      function showPopup(list, showMs){
        if (popupTimer) clearTimeout(popupTimer);
        var fastBody = document.getElementById("fastBody");
        if (!list || !list.length){
          fastBody.innerHTML = '<tr><td colspan="4" class="small">Không có ai trả lời đúng.</td></tr>';
        } else {
          fastBody.innerHTML = list.map(function(x,i){
            return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + fmtMs(x.elapsedMs) + "</td><td>+" + (x.points || 0) + "</td></tr>";
          }).join("");
        }
        document.getElementById("fastPopup").style.display = "flex";
        popupTimer = setTimeout(hidePopup, showMs || 7000);
      }

      function setButtons(){
        document.getElementById("btnCreate").disabled = !socket.connected;
        document.getElementById("btnStart").disabled  = !socket.connected || !code || (state && state.started);
        document.getElementById("btnReveal").disabled = !socket.connected || !code || !(state && state.started) || (state && state.ended);
        document.getElementById("btnNext").disabled   = !socket.connected || !code || !(state && state.started) || (state && state.ended);
      }

      socket.on("connect", function(){ setConn(true,"Đã kết nối"); setButtons(); });
      socket.on("disconnect", function(){ setConn(false,"Mất kết nối"); setButtons(); });
      socket.on("connect_error", function(){ setConn(false,"Lỗi kết nối"); setButtons(); });

      document.getElementById("btnCreate").onclick = function(){
        socket.emit("host:createRoom", {}, function(resp){
          if (!resp || !resp.ok) return alert((resp && resp.error) || "Không tạo được phòng");
          code = resp.code;
          document.getElementById("roomCode").textContent = code;
          hidePopup(); stopAudio(); stopTimer("qaCardHost"); setButtons();
        });
      };

      document.getElementById("btnStart").onclick = function(){
        socket.emit("host:start", { code: code }, function(resp){
          if (!resp || !resp.ok) return alert((resp && resp.error) || "Không thể bắt đầu");
          hidePopup(); stopAudio(); stopTimer("qaCardHost"); setButtons();
        });
      };

      document.getElementById("btnReveal").onclick = function(){
        socket.emit("host:reveal", { code: code }, function(resp){
          if (!resp || !resp.ok) alert((resp && resp.error) || "Lỗi");
        });
      };

      document.getElementById("btnNext").onclick = function(){
        socket.emit("host:next", { code: code }, function(resp){
          if (!resp || !resp.ok) return alert((resp && resp.error) || "Lỗi");
          hidePopup(); stopAudio(); stopTimer("qaCardHost"); setButtons();
        });
      };

      socket.on("players:count", function(p){
        document.getElementById("playersCount").textContent = String((p && p.count) || 0);
      });

      socket.on("room:state", function(s){
        state = s;
        if (state && state.total != null && state.qIndex != null) {
          document.getElementById("qCounter").textContent = String(state.qIndex + 1) + "/" + String(state.total);
        }
        setButtons();
      });

      socket.on("question:progress", function(p){
        document.getElementById("qAnswered").textContent = String(p.answered) + "/" + String(p.totalPlayers);
      });

      socket.on("question:start", function(q){
        hidePopup(); stopAudio(); stopTimer("qaCardHost");

        document.getElementById("qText").textContent = q.text;
        document.getElementById("qAnswered").textContent = "0";

        document.getElementById("choicesHost").innerHTML = q.choices.map(function(c,i){
          var letter = String.fromCharCode(65+i);
          return '<div class="choice"><span class="opt">' + letter + '</span><span class="txt">' + esc(c) + '</span></div>';
        }).join("");

        applyAnswerColors("choicesHost");

        var delay = Math.max(0, q.startedAtMs - (q.serverNowMs || Date.now()));
        var startLocalMs = Date.now() + delay;

        playAudioAfter(delay);
        startTimer("qaCardHost", startLocalMs, q.timeLimitSec * 1000);
      });

      socket.on("question:end", function(p){
        stopAudio(); stopTimer("qaCardHost");

        var totalTop15 = p.totalTop15 || [];
        document.getElementById("lbBody").innerHTML = (totalTop15.length ? totalTop15 : []).map(function(x,i){
          return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + x.score + "</td></tr>";
        }).join("") || '<tr><td colspan="3" class="small">Chưa có dữ liệu.</td></tr>';

        showPopup(p.fastTop5 || [], p.popupShowMs || 7000);
      });

      socket.on("game:end", function(p){
        stopAudio(); stopTimer("qaCardHost");

        var totalTop15 = p.totalTop15 || [];
        document.getElementById("lbBody").innerHTML = (totalTop15.length ? totalTop15 : []).map(function(x,i){
          return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + x.score + "</td></tr>";
        }).join("") || '<tr><td colspan="3" class="small">Chưa có dữ liệu.</td></tr>';

        alert("Kết thúc game! Tổng người chơi: " + p.totalPlayers);
      });

      setButtons();
    </script>
  `));
});

app.get("/play", (_, res) => {
  res.send(layout("Người chơi", `
    <div class="header">
      <h1>Người chơi</h1>
      <div class="row">
        <a class="pill" href="/host">Host (cần key)</a>
        <button id="soundBtn" class="pill" style="display:none;background:transparent;cursor:pointer">🔊 Bật âm thanh</button>
        <span class="pill"><span class="dot" id="connDot"></span><span id="connText">Đang kết nối…</span></span>
      </div>
    </div>

    <audio id="qAudio" preload="auto" src="/audio/olympia.mp3"></audio>

    <div class="grid">
      <div class="card">
        <div class="small">Tham gia phòng</div>
        <div class="row" style="margin-top:8px">
          <div style="flex:1;min-width:220px">
            <label>Mã phòng</label>
            <input id="code" placeholder="ABC123"/>
          </div>
          <div style="flex:1;min-width:220px">
            <label>Tên của bạn</label>
            <input id="name" placeholder="Nguyễn Văn A"/>
          </div>
        </div>
        <div class="row" style="margin-top:10px">
          <button id="btnJoin" class="btn">Tham gia</button>
          <span id="joinStatus" class="small"></span>
        </div>
        <hr/>
        <div class="row">
          <span class="pill">Điểm: <b id="score">0</b></span>
          <span class="pill">Hạng (tạm tính): <b id="rank">—</b></span>
        </div>
        <p class="small" style="margin:10px 0 0">Không hiển thị giây — xem thanh thời gian chạy quanh khung.</p>
      </div>

      <div id="qaCardPlay" class="card qaCard">
        <div class="small">Câu hỏi</div>
        <h2 id="qText" style="margin:6px 0 0;font-size:18px">—</h2>
        <div id="choicesPlay" class="choices"></div>
        <div id="feedback" class="small" style="margin-top:10px"></div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="small">Bảng xếp hạng tổng điểm</div>
      <h2 style="margin:6px 0 0;font-size:18px">Top 15 (tích lũy)</h2>
      <table>
        <thead><tr><th>#</th><th>Tên</th><th>Tổng điểm</th></tr></thead>
        <tbody id="lbBody"><tr><td colspan="3" class="small">Chưa có dữ liệu.</td></tr></tbody>
      </table>
    </div>

    <div id="fastPopup" class="overlay">
      <div class="modal card">
        <div class="header">
          <h1 style="font-size:18px;margin:0">Top 5 đúng & nhanh (câu vừa xong)</h1>
          <span class="pill"><span class="small">Tự tắt sau 7 giây</span></span>
        </div>
        <table>
          <thead><tr><th>#</th><th>Tên</th><th>Thời gian</th><th>+Điểm</th></tr></thead>
          <tbody id="fastBody"></tbody>
        </table>
      </div>
    </div>

    <script>
      var socket = io();
      var esc = function(s){
        return String(s).replace(/[&<>"']/g, function(m){
          return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]);
        });
      };
      function fmtMs(ms){ return (ms/1000).toFixed(2) + "s"; }

      var ANSWER_COLOR_POOL = ["#1D3557","#0B3D91","#264653","#283618","#2F3E46","#3A0CA3","#5A189A","#6A040F","#004E64","#1B263B","#2D1E2F","#006D77"];
      function shuffle(arr){
        var a = arr.slice();
        for (var i = a.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
      }
      function pickAnswerColors(n){
        var pool = shuffle(ANSWER_COLOR_POOL);
        while (pool.length < n) pool = pool.concat(shuffle(ANSWER_COLOR_POOL));
        return pool.slice(0, n);
      }
      function applyAnswerColors(containerId){
        var wrap = document.getElementById(containerId);
        if (!wrap) return;
        var nodes = wrap.querySelectorAll(".choice");
        var colors = pickAnswerColors(nodes.length);
        nodes.forEach(function(node, idx){
          node.style.background = colors[idx];
          node.style.borderColor = "rgba(255,255,255,.32)";
        });
      }

      function ensureTimer(cardId){
        var card = document.getElementById(cardId);
        if (!card) return null;
        if (card.__timerObj) return card.__timerObj;

        var ns = "http://www.w3.org/2000/svg";
        var svg = document.createElementNS(ns, "svg");
        svg.setAttribute("class", "timer-svg");

        var track = document.createElementNS(ns, "rect");
        track.setAttribute("class", "timer-track");

        var prog = document.createElementNS(ns, "rect");
        prog.setAttribute("class", "timer-prog");

        svg.appendChild(track);
        svg.appendChild(prog);
        card.appendChild(svg);

        var obj = { card: card, svg: svg, track: track, prog: prog, len: 0, raf: 0 };

        obj.resize = function(){
          var w = card.clientWidth;
          var h = card.clientHeight;
          var sw = 6;
          var r = 16;
          var rx = Math.max(0, r - sw/2);

          svg.setAttribute("viewBox", "0 0 " + w + " " + h);

          track.setAttribute("x", sw/2);
          track.setAttribute("y", sw/2);
          track.setAttribute("width", Math.max(0, w - sw));
          track.setAttribute("height", Math.max(0, h - sw));
          track.setAttribute("rx", rx);
          track.setAttribute("ry", rx);

          prog.setAttribute("x", sw/2);
          prog.setAttribute("y", sw/2);
          prog.setAttribute("width", Math.max(0, w - sw));
          prog.setAttribute("height", Math.max(0, h - sw));
          prog.setAttribute("rx", rx);
          prog.setAttribute("ry", rx);

          try{
            obj.len = prog.getTotalLength();
            prog.style.strokeDasharray = String(obj.len);
          }catch(e){}
        };

        window.addEventListener("resize", function(){ obj.resize(); });
        obj.resize();

        card.__timerObj = obj;
        return obj;
      }

      function startTimer(cardId, startAtMs, durationMs){
        var t = ensureTimer(cardId);
        if (!t || !t.len) return;

        t.resize();
        if (t.raf) cancelAnimationFrame(t.raf);

        var len = t.len;
        t.prog.style.opacity = "1";
        t.prog.style.strokeDasharray = String(len);
        t.prog.style.strokeDashoffset = String(len);

        function step(){
          var now = Date.now();
          var p = (now - startAtMs) / durationMs;

          if (p < 0) {
            t.prog.style.strokeDashoffset = String(len);
            t.raf = requestAnimationFrame(step);
            return;
          }

          p = Math.max(0, Math.min(1, p));
          t.prog.style.strokeDashoffset = String(len * (1 - p));
          if (p < 1) t.raf = requestAnimationFrame(step);
        }
        t.raf = requestAnimationFrame(step);
      }

      function stopTimer(cardId){
        var t = ensureTimer(cardId);
        if (!t) return;
        if (t.raf) cancelAnimationFrame(t.raf);
        t.raf = 0;
        t.prog.style.opacity = "0";
      }

      var audio = document.getElementById("qAudio");
      var soundBtn = document.getElementById("soundBtn");
      function stopAudio(){ try{ audio.pause(); audio.currentTime = 0; }catch(e){} }
      function playAudioAfter(delayMs){
        stopAudio();
        soundBtn.style.display = "none";
        setTimeout(function(){
          audio.play().catch(function(){ soundBtn.style.display = "inline-flex"; });
        }, delayMs);
      }
      soundBtn.onclick = function(){ audio.play().then(function(){ soundBtn.style.display = "none"; }).catch(function(){}); };

      var dot = document.getElementById("connDot");
      var text = document.getElementById("connText");
      function setConn(ok, msg){
        dot.classList.remove("good","bad");
        dot.classList.add(ok ? "good" : "bad");
        text.textContent = msg;
      }
      socket.on("connect", function(){ setConn(true,"Đã kết nối"); });
      socket.on("disconnect", function(){ setConn(false,"Mất kết nối"); });
      socket.on("connect_error", function(){ setConn(false,"Lỗi kết nối"); });

      var joined = false;
      var roomCode = null;
      var myAnswered = false;
      var enableTimer = null;

      function clearEnable(){ if (enableTimer) clearTimeout(enableTimer); enableTimer = null; }

      function setAnswerEnabled(enabled){
        Array.prototype.forEach.call(document.getElementById("choicesPlay").querySelectorAll("button.choice"), function(b){
          if (!myAnswered) {
            if (enabled) b.removeAttribute("disabled");
            else b.setAttribute("disabled","disabled");
          }
        });
      }

      var popupTimer = null;
      function hidePopup(){ document.getElementById("fastPopup").style.display = "none"; }
      function showPopup(list, showMs){
        if (popupTimer) clearTimeout(popupTimer);
        var fastBody = document.getElementById("fastBody");
        if (!list || !list.length){
          fastBody.innerHTML = '<tr><td colspan="4" class="small">Không có ai trả lời đúng.</td></tr>';
        } else {
          fastBody.innerHTML = list.map(function(x,i){
            return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + fmtMs(x.elapsedMs) + "</td><td>+" + (x.points || 0) + "</td></tr>";
          }).join("");
        }
        document.getElementById("fastPopup").style.display = "flex";
        popupTimer = setTimeout(hidePopup, showMs || 7000);
      }

      document.getElementById("btnJoin").onclick = function(){
        var code = document.getElementById("code").value.trim().toUpperCase();
        var name = document.getElementById("name").value.trim();
        socket.emit("player:join", { code: code, name: name }, function(resp){
          if (!resp || !resp.ok) {
            joined = false;
            document.getElementById("joinStatus").innerHTML = '<span class="bad">✖ ' + esc((resp && resp.error) || "Không tham gia được") + '</span>';
            return;
          }
          joined = true;
          roomCode = code;
          document.getElementById("joinStatus").innerHTML = '<span class="good">✔ Đã vào phòng ' + esc(code) + '</span>';
        });
      };

      socket.on("question:start", function(q){
        if (!joined) return;

        hidePopup(); stopAudio(); stopTimer("qaCardPlay"); clearEnable();
        myAnswered = false;
        document.getElementById("feedback").textContent = "";
        document.getElementById("qText").textContent = q.text;

        document.getElementById("choicesPlay").innerHTML = q.choices.map(function(c,i){
          var letter = String.fromCharCode(65+i);
          return '<button class="choice" data-i="' + i + '" disabled>' +
                   '<span class="opt">' + letter + '</span>' +
                   '<span class="txt">' + esc(c) + '</span>' +
                 '</button>';
        }).join("");

        applyAnswerColors("choicesPlay");

        var delay = Math.max(0, q.startedAtMs - (q.serverNowMs || Date.now()));
        var startLocalMs = Date.now() + delay;

        playAudioAfter(delay);
        startTimer("qaCardPlay", startLocalMs, q.timeLimitSec * 1000);

        enableTimer = setTimeout(function(){ setAnswerEnabled(true); }, delay);

        Array.prototype.forEach.call(document.getElementById("choicesPlay").querySelectorAll("button.choice"), function(btn){
          btn.onclick = function(){
            if (myAnswered) return;
            if (btn.hasAttribute("disabled")) return;

            myAnswered = true;
            var choiceIndex = Number(btn.getAttribute("data-i"));
            setAnswerEnabled(false);

            socket.emit("player:answer", { code: roomCode, choiceIndex: choiceIndex }, function(resp){
              if (!resp || !resp.ok) {
                document.getElementById("feedback").innerHTML = '<span class="bad">✖ ' + esc((resp && resp.error) || "Lỗi") + '</span>';
                return;
              }
              document.getElementById("score").textContent = String(resp.totalScore || 0);
              document.getElementById("rank").textContent = String(resp.rank || "—");
              document.getElementById("feedback").innerHTML = resp.correct
                ? '<span class="good">✔ Đúng</span> • +' + resp.points + " điểm"
                : '<span class="bad">✖ Sai</span> • +0 điểm';
            });
          };
        });
      });

      socket.on("question:end", function(p){
        if (!joined) return;

        stopAudio(); stopTimer("qaCardPlay"); clearEnable();

        var totalTop15 = p.totalTop15 || [];
        document.getElementById("lbBody").innerHTML = (totalTop15.length ? totalTop15 : []).map(function(x,i){
          return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + x.score + "</td></tr>";
        }).join("") || '<tr><td colspan="3" class="small">Chưa có dữ liệu.</td></tr>';

        showPopup(p.fastTop5 || [], p.popupShowMs || 7000);
      });

      socket.on("game:end", function(p){
        stopAudio(); stopTimer("qaCardPlay"); clearEnable();

        var totalTop15 = p.totalTop15 || [];
        document.getElementById("lbBody").innerHTML = (totalTop15.length ? totalTop15 : []).map(function(x,i){
          return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + x.score + "</td></tr>";
        }).join("") || '<tr><td colspan="3" class="small">Chưa có dữ liệu.</td></tr>';

        alert("Kết thúc game! Tổng người chơi: " + p.totalPlayers);
      });
    </script>
  `));
});

/* ================== SOCKET.IO ================== */
function socketIsHost(socket) {
  const cookies = parseCookies(socket.request.headers.cookie || "");
  return cookies[HOST_COOKIE_NAME] === hostSig();
}

io.on("connection", (socket) => {
  socket.on("host:createRoom", (_, ack) => {
    if (!socketIsHost(socket)) return ack && ack({ ok: false, error: "Bạn cần HOST KEY để dùng Host." });

    const code = makeCode();
    const room = {
      code,
      hostId: socket.id,
      createdAt: Date.now(),
      started: false,
      ended: false,
      qIndex: 0,
      qStartAtMs: 0,
      timer: null,
      players: new Map()
    };
    rooms.set(code, room);
    socket.join(code);

    ack && ack({ ok: true, code });
    broadcast(room);
  });

  socket.on("host:start", ({ code }, ack) => {
    if (!socketIsHost(socket)) return ack && ack({ ok: false, error: "Bạn cần HOST KEY để dùng Host." });

    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: "Không tìm thấy phòng" });
    if (room.hostId !== socket.id) return ack && ack({ ok: false, error: "Bạn không phải Host" });
    if (room.started) return ack && ack({ ok: false, error: "Phòng đã bắt đầu rồi" });

    room.started = true;
    room.ended = false;
    room.qIndex = 0;
    startQuestion(room);
    ack && ack({ ok: true });
  });

  socket.on("host:reveal", ({ code }, ack) => {
    if (!socketIsHost(socket)) return ack && ack({ ok: false, error: "Bạn cần HOST KEY để dùng Host." });

    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: "Không tìm thấy phòng" });
    if (room.hostId !== socket.id) return ack && ack({ ok: false, error: "Bạn không phải Host" });

    endQuestion(room);
    ack && ack({ ok: true });
  });

  socket.on("host:next", ({ code }, ack) => {
    if (!socketIsHost(socket)) return ack && ack({ ok: false, error: "Bạn cần HOST KEY để dùng Host." });

    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: "Không tìm thấy phòng" });
    if (room.hostId !== socket.id) return ack && ack({ ok: false, error: "Bạn không phải Host" });
    if (!room.started) return ack && ack({ ok: false, error: "Chưa bắt đầu" });

    endQuestion(room);
    room.qIndex += 1;

    if (room.qIndex >= QUIZ.questions.length) {
      endGame(room);
      return ack && ack({ ok: true, ended: true });
    }

    startQuestion(room);
    ack && ack({ ok: true, ended: false });
  });

  socket.on("player:join", ({ code, name }, ack) => {
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: "Mã phòng không đúng" });
    if (room.ended) return ack && ack({ ok: false, error: "Game đã kết thúc" });

    const cleanName = String(name || "").trim().slice(0, 24);
    if (!cleanName) return ack && ack({ ok: false, error: "Bạn cần nhập tên" });

    room.players.set(socket.id, { name: cleanName, score: 0, lastAnswer: null });
    socket.join(code);

    io.to(code).emit("players:count", { count: room.players.size });

    ack && ack({ ok: true });

    if (room.started && !room.ended) socket.emit("question:start", safeQuestionPayload(room));
    broadcast(room);
  });

  socket.on("player:answer", ({ code, choiceIndex }, ack) => {
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: "Không tìm thấy phòng" });
    if (!room.started || room.ended) return ack && ack({ ok: false, error: "Game chưa chạy hoặc đã kết thúc" });

    const p = room.players.get(socket.id);
    if (!p) return ack && ack({ ok: false, error: "Bạn chưa tham gia" });

    const q = QUIZ.questions[room.qIndex];
    if (!q) return ack && ack({ ok: false, error: "Không có câu hỏi" });

    if (Date.now() < room.qStartAtMs) {
      return ack && ack({ ok: false, error: "Chưa bắt đầu, chờ 0.5 giây..." });
    }

    if (p.lastAnswer && p.lastAnswer.qIndex === room.qIndex) {
      return ack && ack({ ok: false, error: "Bạn đã trả lời câu này rồi" });
    }

    const elapsedMs = Date.now() - room.qStartAtMs;
    const selected = Number(choiceIndex);
    const correct = selected === q.correctIndex;

    const pts = computePoints({ correct, elapsedMs, limitSec: q.timeLimitSec });
    p.score += pts;

    p.lastAnswer = { qIndex: room.qIndex, choiceIndex: selected, elapsedMs, correct, points: pts };

    const leaderboard = getTotalLeaderboard(room);
    const rank = leaderboard.findIndex((x) => x.socketId === socket.id) + 1;

    ack && ack({ ok: true, correct, points: pts, totalScore: p.score, rank });

    let answered = 0;
    for (const pl of room.players.values()) {
      if (pl.lastAnswer && pl.lastAnswer.qIndex === room.qIndex) answered++;
    }
    io.to(code).emit("question:progress", { answered, totalPlayers: room.players.size });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.hostId === socket.id) {
        endGame(room);
        rooms.delete(room.code);
        continue;
      }
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        io.to(room.code).emit("players:count", { count: room.players.size });
        broadcast(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Realtime quiz running on port", PORT));
