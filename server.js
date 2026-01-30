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

/* ================== QUIZ ================== */
const PRE_DELAY_MS = 500;      // ✅ CHUẨN BỊ 0.5s -> sau đó nhạc chạy + bắt đầu trả lời
const POPUP_SHOW_MS = 7000;    // popup top 5 hiện 7s
const MAX_POINTS = 1000;

const QUIZ = {
  title: "Quiz Realtime – 20s + Nhạc Olympia + Popup Top 5",
  questions: [
    {
      text: "1) Thủ đô của Việt Nam là gì?",
      choices: ["TP.HCM", "Hà Nội", "Đà Nẵng", "Huế"],
      correctIndex: 1,
      timeLimitSec: 20
    },
    {
      text: "2) 5 x 6 = ?",
      choices: ["11", "25", "30", "56"],
      correctIndex: 2,
      timeLimitSec: 20
    },
    {
      text: "3) Biển Đông tiếng Anh là gì?",
      choices: ["East Sea", "Red Sea", "Black Sea", "Yellow Sea"],
      correctIndex: 0,
      timeLimitSec: 20
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
app.use(express.urlencoded({ extended: false }));

// phục vụ file nhạc: public/audio/olympia.mp3
app.use("/audio", express.static(path.join(__dirname, "public", "audio"), { maxAge: "7d" }));

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

// Top 5 đúng & nhanh của câu vừa xong (7s chỉ là thời gian HIỂN THỊ popup)
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

  // bắt đầu trả lời sau 0.5s
  room.qStartAtMs = Date.now() + PRE_DELAY_MS;

  for (const p of room.players.values()) p.lastAnswer = null;

  io.to(room.code).emit("question:start", safeQuestionPayload(room));

  const q = QUIZ.questions[room.qIndex];

  // tổng thời gian: prep 0.5s + 20s trả lời
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

/* ================== HTML LAYOUT ================== */
function layout(title, body) {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
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

    /* ĐÁP ÁN TƯƠNG PHẢN CAO */
    .choice{
      display:flex;align-items:center;gap:12px;
      padding:14px 14px;border-radius:14px;
      border:1px solid rgba(231,236,255,.22);
      background:rgba(0,0,0,.32);color:var(--text);
      cursor:pointer;text-align:left;
    }
    .choice:hover{background:rgba(0,0,0,.42);border-color: rgba(231,236,255,.38);}
    .choice[disabled]{opacity:.78;cursor:not-allowed;}
    .choice .opt{
      width:34px;height:34px;border-radius:10px;
      display:flex;align-items:center;justify-content:center;
      font-weight:900;letter-spacing:.5px;
      background:rgba(231,236,255,.95);color:#0b1020;
      border:1px solid rgba(0,0,0,.18);flex:0 0 auto;
    }
    .choice .txt{flex:1;font-weight:700;line-height:1.25;}

    .badge{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);background:rgba(0,0,0,.14);color:var(--muted)}
    .good{color:var(--good)} .bad{color:var(--bad)}
    table{width:100%;border-collapse:collapse;margin-top:10px}
    th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;font-size:14px}
    th{color:var(--muted);font-weight:800}

    .overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;padding:16px;z-index:9999}
    .modal{max-width:720px;width:100%}
  </style>
</head>
<body>
  <script src="/socket.io/socket.io.js"></script>
  <div class="container">${body}</div>
</body>
</html>`;
}

/* ================== ROUTES ================== */
app.get("/health", (_, res) => res.json({ ok: true }));

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

// Cho phép /host?key=... set cookie nhanh
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
            <div class="small">Chuẩn bị <b>0.5s</b> → nhạc chạy + bắt đầu trả lời <b>20s</b>.</div>
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

      <div class="card">
        <div class="small">Câu hỏi đang chạy</div>
        <h2 id="qText" style="margin:6px 0 0;font-size:18px">—</h2>
        <div class="row" style="margin-top:8px">
          <span class="badge">Thời gian: <b id="qTime">—</b></span>
          <span class="badge">Đã trả lời: <b id="qAnswered">0</b></span>
        </div>
        <div id="choices" class="choices"></div>
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

      var audio = $("qAudio");
      var soundBtn = $("soundBtn");
      function stopAudio(){
        try{ audio.pause(); audio.currentTime = 0; }catch(e){}
      }
      function playAudioAfter(delayMs){
        stopAudio();
        soundBtn.style.display = "none";
        setTimeout(function(){
          audio.play().catch(function(){
            soundBtn.style.display = "inline-flex";
          });
        }, delayMs);
      }
      soundBtn.onclick = function(){
        audio.play().then(function(){
          soundBtn.style.display = "none";
        }).catch(function(){});
      };

      var dot = $("connDot");
      var text = $("connText");
      function setConn(ok, msg){
        dot.classList.remove("good","bad");
        dot.classList.add(ok ? "good" : "bad");
        text.textContent = msg;
      }

      var code = null;
      var state = null;

      var popupTimer = null;
      function hidePopup(){ $("fastPopup").style.display = "none"; }
      function showPopup(list, showMs){
        if (popupTimer) clearTimeout(popupTimer);

        if (!list || !list.length){
          $("fastBody").innerHTML = '<tr><td colspan="4" class="small">Không có ai trả lời đúng.</td></tr>';
        } else {
          $("fastBody").innerHTML = list.map(function(x,i){
            return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + fmtMs(x.elapsedMs) + "</td><td>+" + (x.points || 0) + "</td></tr>";
          }).join("");
        }

        $("fastPopup").style.display = "flex";
        popupTimer = setTimeout(hidePopup, showMs || 7000);
      }

      function setButtons(){
        $("btnCreate").disabled = !socket.connected;
        $("btnStart").disabled  = !socket.connected || !code || (state && state.started);
        $("btnReveal").disabled = !socket.connected || !code || !(state && state.started) || (state && state.ended);
        $("btnNext").disabled   = !socket.connected || !code || !(state && state.started) || (state && state.ended);
      }

      socket.on("connect", function(){ setConn(true,"Đã kết nối"); setButtons(); });
      socket.on("disconnect", function(){ setConn(false,"Mất kết nối"); setButtons(); });
      socket.on("connect_error", function(){ setConn(false,"Lỗi kết nối"); setButtons(); });

      $("btnCreate").onclick = function(){
        socket.emit("host:createRoom", {}, function(resp){
          if (!resp || !resp.ok) return alert((resp && resp.error) || "Không tạo được phòng");
          code = resp.code;
          $("roomCode").textContent = code;
          hidePopup();
          stopAudio();
          setButtons();
        });
      };

      $("btnStart").onclick = function(){
        socket.emit("host:start", { code: code }, function(resp){
          if (!resp || !resp.ok) return alert((resp && resp.error) || "Không thể bắt đầu");
          hidePopup();
          stopAudio();
          setButtons();
        });
      };

      $("btnReveal").onclick = function(){
        socket.emit("host:reveal", { code: code }, function(resp){
          if (!resp || !resp.ok) alert((resp && resp.error) || "Lỗi");
        });
      };

      $("btnNext").onclick = function(){
        socket.emit("host:next", { code: code }, function(resp){
          if (!resp || !resp.ok) return alert((resp && resp.error) || "Lỗi");
          hidePopup();
          stopAudio();
          setButtons();
        });
      };

      socket.on("players:count", function(p){
        $("playersCount").textContent = String((p && p.count) || 0);
      });

      socket.on("room:state", function(s){
        state = s;
        if (state && state.total != null && state.qIndex != null) {
          var cur = state.qIndex + (state.started ? 1 : 0);
          $("qCounter").textContent = String(cur) + "/" + String(state.total);
        }
        setButtons();
      });

      socket.on("question:progress", function(p){
        $("qAnswered").textContent = String(p.answered) + "/" + String(p.totalPlayers);
      });

      socket.on("question:start", function(q){
        hidePopup();
        stopAudio();

        $("qText").textContent = q.text;
        $("qTime").textContent = String(q.timeLimitSec) + "s";
        $("qAnswered").textContent = "0";

        $("choices").innerHTML = q.choices.map(function(c,i){
          var letter = String.fromCharCode(65+i);
          return '<div class="choice">' +
                   '<span class="opt">' + letter + '</span>' +
                   '<span class="txt">' + esc(c) + '</span>' +
                 '</div>';
        }).join("");

        var delay = Math.max(0, q.startedAtMs - Date.now());
        playAudioAfter(delay);
      });

      socket.on("question:end", function(p){
        stopAudio();

        var totalTop15 = p.totalTop15 || [];
        $("lbBody").innerHTML = totalTop15.map(function(x,i){
          return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + x.score + "</td></tr>";
        }).join("") || "<tr><td colspan=\\"3\\" class=\\"small\\">Chưa có dữ liệu.</td></tr>";

        showPopup(p.fastTop5 || [], p.popupShowMs || 7000);

        var correctIndex = p.correctIndex;
        var nodes = $("choices").querySelectorAll(".choice");
        nodes.forEach(function(node, idx){
          if (idx === correctIndex) {
            var txt = node.querySelector(".txt");
            if (txt) txt.innerHTML = txt.innerHTML + ' <span class="badge good">✔ đúng</span>';
          }
        });
      });

      socket.on("game:end", function(p){
        stopAudio();
        var totalTop15 = p.totalTop15 || [];
        $("lbBody").innerHTML = totalTop15.map(function(x,i){
          return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + x.score + "</td></tr>";
        }).join("") || "<tr><td colspan=\\"3\\" class=\\"small\\">Chưa có dữ liệu.</td></tr>";
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
          <span class="pill"><b id="timeLeft">—</b></span>
        </div>
        <p class="small" style="margin:10px 0 0">Chuẩn bị <b>0.5s</b> → nhạc chạy + bắt đầu trả lời <b>20s</b>.</p>
      </div>

      <div class="card">
        <div class="small">Câu hỏi</div>
        <h2 id="qText" style="margin:6px 0 0;font-size:18px">—</h2>
        <div id="choices" class="choices"></div>
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
      var $ = function(id){ return document.getElementById(id); };
      var esc = function(s){
        return String(s).replace(/[&<>"']/g, function(m){
          return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]);
        });
      };
      function fmtMs(ms){ return (ms/1000).toFixed(2) + "s"; }

      var audio = $("qAudio");
      var soundBtn = $("soundBtn");
      function stopAudio(){
        try{ audio.pause(); audio.currentTime = 0; }catch(e){}
      }
      function playAudioAfter(delayMs){
        stopAudio();
        soundBtn.style.display = "none";
        setTimeout(function(){
          audio.play().catch(function(){
            soundBtn.style.display = "inline-flex";
          });
        }, delayMs);
      }
      soundBtn.onclick = function(){
        audio.play().then(function(){
          soundBtn.style.display = "none";
        }).catch(function(){});
      };

      var dot = $("connDot");
      var text = $("connText");
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
      var timer = null;
      var myAnswered = false;
      var enableTimer = null;

      function clearTimer(){ if (timer) clearInterval(timer); timer = null; }
      function clearEnable(){ if (enableTimer) clearTimeout(enableTimer); enableTimer = null; }

      function setAnswerEnabled(enabled){
        Array.prototype.forEach.call($("choices").querySelectorAll("button.choice"), function(b){
          if (!myAnswered) {
            if (enabled) b.removeAttribute("disabled");
            else b.setAttribute("disabled","disabled");
          }
        });
      }

      // hiển thị: "Chuẩn bị: ..." trong giai đoạn 0.5s (mượt hơn)
      function setCountdown(startAtMs, timeLimitSec){
        clearTimer();
        function tick(){
          var now = Date.now();
          if (now < startAtMs){
            var prepMs = startAtMs - now;
            $("timeLeft").textContent = "Chuẩn bị: " + (prepMs/1000).toFixed(1) + "s";
            return;
          }
          var elapsed = now - startAtMs;
          var remainMs = Math.max(0, timeLimitSec*1000 - elapsed);
          $("timeLeft").textContent = "Còn lại: " + (remainMs/1000).toFixed(1) + "s";
          if (remainMs <= 0) clearTimer();
        }
        tick();
        timer = setInterval(tick, 100);
      }

      var popupTimer = null;
      function hidePopup(){ $("fastPopup").style.display = "none"; }
      function showPopup(list, showMs){
        if (popupTimer) clearTimeout(popupTimer);

        if (!list || !list.length){
          $("fastBody").innerHTML = '<tr><td colspan="4" class="small">Không có ai trả lời đúng.</td></tr>';
        } else {
          $("fastBody").innerHTML = list.map(function(x,i){
            return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + fmtMs(x.elapsedMs) + "</td><td>+" + (x.points || 0) + "</td></tr>";
          }).join("");
        }

        $("fastPopup").style.display = "flex";
        popupTimer = setTimeout(hidePopup, showMs || 7000);
      }

      $("btnJoin").onclick = function(){
        var code = $("code").value.trim().toUpperCase();
        var name = $("name").value.trim();
        socket.emit("player:join", { code: code, name: name }, function(resp){
          if (!resp || !resp.ok) {
            joined = false;
            $("joinStatus").innerHTML = '<span class="bad">✖ ' + esc((resp && resp.error) || "Không tham gia được") + '</span>';
            return;
          }
          joined = true;
          roomCode = code;
          $("joinStatus").innerHTML = '<span class="good">✔ Đã vào phòng ' + esc(code) + '</span>';
        });
      };

      socket.on("question:start", function(q){
        if (!joined) return;

        hidePopup();
        stopAudio();
        clearEnable();

        myAnswered = false;
        $("feedback").textContent = "";
        $("qText").textContent = q.text;

        // tạo đáp án (disable trong thời gian chuẩn bị 0.5s)
        $("choices").innerHTML = q.choices.map(function(c,i){
          var letter = String.fromCharCode(65+i);
          return '<button class="choice" data-i="' + i + '" disabled>' +
                   '<span class="opt">' + letter + '</span>' +
                   '<span class="txt">' + esc(c) + '</span>' +
                 '</button>';
        }).join("");

        var delay = Math.max(0, q.startedAtMs - Date.now());

        // bật nhạc đúng lúc bắt đầu
        playAudioAfter(delay);

        // đếm thời gian: chuẩn bị -> 20s
        setCountdown(q.startedAtMs, q.timeLimitSec);

        // enable trả lời đúng lúc bắt đầu
        enableTimer = setTimeout(function(){
          setAnswerEnabled(true);
        }, delay);

        Array.prototype.forEach.call($("choices").querySelectorAll("button.choice"), function(btn){
          btn.onclick = function(){
            if (myAnswered) return;
            if (Date.now() < q.startedAtMs) return;

            myAnswered = true;

            var choiceIndex = Number(btn.getAttribute("data-i"));
            setAnswerEnabled(false);

            socket.emit("player:answer", { code: roomCode, choiceIndex: choiceIndex }, function(resp){
              if (!resp || !resp.ok) {
                $("feedback").innerHTML = '<span class="bad">✖ ' + esc((resp && resp.error) || "Lỗi") + '</span>';
                return;
              }
              $("score").textContent = String(resp.totalScore || 0);
              $("rank").textContent = String(resp.rank || "—");
              $("feedback").innerHTML = resp.correct
                ? '<span class="good">✔ Đúng</span> • +' + resp.points + " điểm"
                : '<span class="bad">✖ Sai</span> • +0 điểm';
            });
          };
        });
      });

      socket.on("question:end", function(p){
        if (!joined) return;

        stopAudio();
        clearEnable();
        clearTimer();

        var totalTop15 = p.totalTop15 || [];
        $("lbBody").innerHTML = totalTop15.map(function(x,i){
          return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + x.score + "</td></tr>";
        }).join("") || "<tr><td colspan=\\"3\\" class=\\"small\\">Chưa có dữ liệu.</td></tr>";

        showPopup(p.fastTop5 || [], p.popupShowMs || 7000);
      });

      socket.on("game:end", function(p){
        stopAudio();
        clearEnable();
        clearTimer();

        var totalTop15 = p.totalTop15 || [];
        $("lbBody").innerHTML = totalTop15.map(function(x,i){
          return "<tr><td>" + (i+1) + "</td><td>" + esc(x.name) + "</td><td>" + x.score + "</td></tr>";
        }).join("") || "<tr><td colspan=\\"3\\" class=\\"small\\">Chưa có dữ liệu.</td></tr>";
        alert("Kết thúc game! Tổng người chơi: " + p.totalPlayers);
      });
    </script>
  `));
});

/* ================== SOCKET.IO (Host key chặn host events) ================== */
function socketIsHost(socket) {
  const cookies = parseCookies(socket.request.headers.cookie || "");
  return cookies[HOST_COOKIE_NAME] === hostSig();
}

io.on("connection", (socket) => {
  socket.on("host:createRoom", (_, ack) => {
    if (!socketIsHost(socket)) return ack && ack({ ok: false, error: "Bạn cần HOST KEY để dùng chức năng Host." });

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
    if (!socketIsHost(socket)) return ack && ack({ ok: false, error: "Bạn cần HOST KEY để dùng chức năng Host." });

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
    if (!socketIsHost(socket)) return ack && ack({ ok: false, error: "Bạn cần HOST KEY để dùng chức năng Host." });

    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: "Không tìm thấy phòng" });
    if (room.hostId !== socket.id) return ack && ack({ ok: false, error: "Bạn không phải Host" });

    endQuestion(room);
    ack && ack({ ok: true });
  });

  socket.on("host:next", ({ code }, ack) => {
    if (!socketIsHost(socket)) return ack && ack({ ok: false, error: "Bạn cần HOST KEY để dùng chức năng Host." });

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
