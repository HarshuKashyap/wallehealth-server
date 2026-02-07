require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

const app = express();
const runningAI = new Set();

/* ================= BASIC SETUP ================= */
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: "64kb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
  })
);

/* ================= FIREBASE ================= */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

/* ================= AUTH ================= */
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (token !== process.env.BASIC_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* ================= TEST ================= */
app.get("/test", (req, res) => {
  res.json({ ok: true });
});

/* =================================================
   🧠 CHAT (AI ONLY HERE – FREE TIER SAFE)
   ================================================= */
app.post("/chat", auth, async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) {
    return res.status(400).json({ error: "Missing data" });
  }

  const chatRef = admin
    .firestore()
    .collection("users")
    .doc(userId)
    .collection("chat");

  // Save user message
  await chatRef.add({
    role: "user",
    text: message,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const today = new Date().toISOString().split("T")[0];

  // 🔒 Only 1 AI reply per day
  const aiCount = await chatRef
    .where("role", "==", "assistant")
    .where("aiDate", "==", today)
    .get();

  if (aiCount.size >= 1) {
    const fallback = "I’m here with you. Tell me a little more 💙";
    await chatRef.add({
      role: "assistant",
      text: fallback,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ answer: fallback });
  }

  // Placeholder
  const aiDoc = await chatRef.add({
    role: "assistant",
    text: "...",
    aiDate: today,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  processChatAI(userId, aiDoc.id).catch(() => {});
  res.json({ answer: "I’m listening… 💙", pending: true });
});

/* ================= CHAT AI WORKER ================= */
async function processChatAI(userId, aiMsgId) {
  if (runningAI.has(userId)) return;
  runningAI.add(userId);

  const chatRef = admin
    .firestore()
    .collection("users")
    .doc(userId)
    .collection("chat");

  try {
    const snap = await chatRef
      .orderBy("createdAt", "desc")
      .limit(6)
      .get();

    const messages = [
      {
        role: "system",
        content:
          "You are WALLE, a caring emotional companion. Be human and supportive.",
      },
    ];

    snap.docs.reverse().forEach((d) => {
      messages.push({ role: d.data().role, content: d.data().text });
    });

    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL,
        messages,
        temperature: 0.4,
        max_tokens: 200,
      },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` },
        timeout: 7000,
      }
    );

    await chatRef.doc(aiMsgId).update({
      text: r.data.choices[0].message.content,
    });
  } catch (e) {
    await chatRef.doc(aiMsgId).update({
      text: "I’m here with you 💙",
    });
  } finally {
    runningAI.delete(userId);
  }
}

/* =================================================
   📅 DAILY TASKS (AI ONCE PER DAY – बाकी STATIC)
   ================================================= */
app.post("/daily-tasks", auth, async (req, res) => {
  const { userId } = req.body;
  const today = new Date().toISOString().split("T")[0];

  const ref = admin
    .firestore()
    .collection("users")
    .doc(userId)
    .collection("dailyTasks")
    .doc(today);

  const snap = await ref.get();
  if (snap.exists) return res.json(snap.data());

  // 🔹 Static fallback (Duolingo style)
  const task = {
    body: { task: "Drink water", reason: "Helps your body reset" },
    mind: { task: "Take 3 deep breaths", reason: "Calms your mind" },
    awareness: { task: "Notice one good thing", reason: "Builds positivity" },
    source: "static",
  };

  await ref.set(task);
  res.json(task);
});

/* =================================================
   🚶 JOURNEY / COURSE (NO AI – STATIC)
   ================================================= */
app.post("/journey-session", auth, (req, res) => {
  res.json({
    title: "Calm Start",
    steps: ["Breathe slowly", "Relax shoulders", "Drink water"],
    ending: "Small steps matter 💙",
  });
});

/* =================================================
   🔔 NOTIFICATIONS (TEMPLATE ONLY)
   ================================================= */
app.post("/send", auth, async (req, res) => {
  const { userId, token, title, body } = req.body;

  await admin.messaging().send({
    token,
    data: { title, body, screen: "Home" },
    android: { priority: "high" },
  });

  await admin
    .firestore()
    .collection("users")
    .doc(userId)
    .collection("notifications")
    .add({
      title,
      message: body,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  res.json({ success: true });
});

/* ================= START ================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on", PORT));
