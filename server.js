require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const runningAI = new Set();

const app = express();

/* ================= RENDER FIX ================= */
app.set("trust proxy", 1);

/* ================= TEST ROUTE ================= */
app.get("/test", (req, res) => {
  res.json({ status: "Server running OK!" });
});

/* ================= FIREBASE ADMIN INIT ================= */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

/* ================= SECURITY ================= */
app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: "64kb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
  })
);

/* ================= API KEY AUTH ================= */
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ error: "No authorization header" });

  const token = authHeader.split(" ")[1];
  if (token !== process.env.BASIC_API_KEY)
    return res.status(401).json({ error: "Invalid API Key" });

  next();
}

app.post("/welcome", auth, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }

    const snap = await admin.firestore().collection("users").doc(userId).get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });

    const data = snap.data();
    if (!data.fcmToken) {
      return res.json({ skipped: true });
    }

    const title = "👋 Welcome to WALLE";
    const body = "WALLE is here to take care of your mind & body, every day 💙";

    await admin.messaging().send({
      token: data.fcmToken,
      data: {
        title,
        body,
        screen: "Home",
      },
      android: { priority: "high" },
    });

    await admin.firestore()
      .collection("users")
      .doc(userId)
      .collection("notifications")
      .add({
        title,
        message: body,
        screen: "Home",
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ success: true });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    res.status(500).json({ error: "Welcome failed" });
  }
});

/* ================= CHAT ================= */
app.post("/chat", auth, async (req, res) => {
  const { message, userId } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: "Missing data" });
  }

  const chatRef = admin
    .firestore()
    .collection("users")
    .doc(userId)
    .collection("chat");

  // 1️⃣ Save user message
  await chatRef.add({
    role: "user",
    text: message,
    status: "done",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 2️⃣ Create assistant placeholder
  const aiDoc = await chatRef.add({
    role: "assistant",
    text: "...",
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 3️⃣ Run AI in background (DO NOT await)
  processChatAI(userId, aiDoc.id).catch(console.error);

  // 4️⃣ Instant reply to user (UX smooth)
  res.json({
    answer: "I’m listening… 💙",
    pending: true,
  });
});



/* ================= SUMMARY ================= */
app.post("/symptom-summary", auth, async (req, res) => {
  try {
    const { symptoms } = req.body;

    const textData = symptoms
      .map((s) => `${s.symptom || ""} - ${s.notes || ""}`)
      .join("; ");

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL,
        messages: [
          { role: "system", content: "You summarize symptoms safely." },
          { role: "user", content: textData },
        ],
        temperature: 0.4,
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` } }
    );

    res.json({ summary: response.data.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: "AI summary generation failed" });
  }
});

app.post("/daily-tasks", auth, async (req, res) => {
  try {
    const { userId, symptoms = [] } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }

    const today = new Date().toISOString().split("T")[0];

    const taskRef = admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection("dailyTasks")
      .doc(today);

    // 🔹 1️⃣ Check cache
    const snap = await taskRef.get();
    if (snap.exists) {
      return res.json(snap.data());
    }

    // 🔹 2️⃣ Build AI prompt
    const text = symptoms.map((s) => `- ${s.text || ""}`).join("\n");

    const prompt = `
User ke recent symptoms:
${text}

In symptoms ke base par 3 daily health tasks banao:

Rules:
- Sirf aaj ke liye
- Kal ke tasks repeat na ho
- Simple, human language
- No medical diagnosis

Output JSON only:
{
  "body": { "task": "", "reason": "" },
  "mind": { "task": "", "reason": "" },
  "awareness": { "task": "", "reason": "" }
}
`;

    // 🔹 3️⃣ AI CALL (ONCE PER DAY)
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6,
        max_tokens: 300,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        },
        timeout: 7000,
      }
    );

    const raw = response.data.choices[0].message.content;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Invalid JSON from AI");

    const taskData = {
      ...JSON.parse(match[0]),
      date: today,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "ai",
    };

    // 🔹 4️⃣ SAVE
    await taskRef.set(taskData);

    // 🔹 5️⃣ RETURN
    res.json(taskData);
  } catch (err) {
    console.error("DAILY TASK ERROR:", err.message);

    // 🛟 Safe fallback
    res.json({
      body: { task: "Drink water slowly", reason: "Hydration helps balance energy" },
      mind: { task: "Take 3 deep breaths", reason: "Calms your nervous system" },
      awareness: { task: "Notice one good thing today", reason: "Builds positivity" },
      source: "fallback",
    });
  }
});

app.post("/weekly-summary", auth, async (req, res) => {
  try {
    const { days } = req.body;

    const text = days
      .map(
        (d, i) =>
          `Day ${i + 1}:
Symptoms: ${d.symptoms.join(", ") || "None"}
Tasks Done: ${d.done}/${d.total}`
      )
      .join("\n\n");

    const prompt = `
You are a caring health companion.

Here is user's last 7 days data:
${text}

Write a short, warm weekly reflection in simple English.
Rules:
- No diagnosis
- Supportive & human tone
- 3–4 lines only
- Encourage gently

Example style:
"Is week you felt tired more often.
Still, you showed up for yourself.
Next week, let’s focus on better sleep and hydration."
`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL,
        messages: [
          { role: "system", content: "You generate weekly health reflections." },
          { role: "user", content: prompt },
        ],
        temperature: 0.5,
        max_tokens: 200,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        },
      }
    );

    const message = response.data.choices[0].message.content;

    res.json({ message });
  } catch (e) {
    console.error("WEEKLY SUMMARY ERROR:", e);
    res.status(500).json({ error: "Weekly summary failed" });
  }
});

const PDFDocument = require("pdfkit");

app.post("/weekly-report-pdf", auth, async (req, res) => {
  try {
    const { message, days, userName } = req.body;

    if (!days || !Array.isArray(days) || days.length === 0) {
      return res.status(400).json({ error: "No weekly data" });
    }

    const doc = new PDFDocument();
    let buffers = [];

    doc.on("data", buffers.push.bind(buffers));
    doc.on("end", () => {
      const pdfData = Buffer.concat(buffers);
      res
        .writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment; filename=weekly_report.pdf",
        })
        .end(pdfData);
    });

    doc.fontSize(20).text("WALLE – Weekly Health Report", { align: "center" });
    doc.moveDown();
    doc.fontSize(14).text(`Patient: ${userName || "User"}`);
    doc.moveDown();

    doc.fontSize(12).text("Weekly Reflection:");
    doc.moveDown();
    doc.text(message || "No reflection available.");
    doc.moveDown();

    doc.fontSize(12).text("7-Day Summary:");
    doc.moveDown();

    days.forEach((d, i) => {
      doc.text(
        `Day ${i + 1}\nSymptoms: ${d.symptoms?.join(", ") || "None"}\nTasks: ${d.done}/${d.total}\n`
      );
      doc.moveDown();
    });

    doc.end();
  } catch (e) {
    console.error("PDF ERROR:", e);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

/* ================= JOURNEY SESSION (DUOLINGO STYLE) ================= */
app.post("/journey-session", auth, async (req, res) => {
  try {
    const { day, focus, streak } = req.body;

    const prompt = `
You are WALLE, a caring health companion.

User is on Day ${day}.
Focus: ${focus || "general health"}
Streak: ${streak || 0}

Generate a short daily health session:
- Title
- 3 simple steps
- 1 reflective question
- 1 warm closing line

Rules:
- No medical diagnosis
- Friendly & human tone
- Fresh and motivating
- Short & simple
- Not repetitive

Output JSON only:
{
  "title": "",
  "steps": ["", "", ""],
  "question": "",
  "ending": ""
}
`;

    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 220,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        },
        timeout: 7000,
      }
    );

    const raw = r.data.choices[0].message.content;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Invalid JSON from AI");

    const json = JSON.parse(match[0]);
    res.json(json);
  } catch (e) {
    console.error("JOURNEY SESSION ERROR:", e);

    // 🔥 Safe fallback – app kabhi rukega nahi
    res.json({
      title: "Today with WALLE",
      steps: [
        "Take 3 slow breaths.",
        "Notice how your body feels.",
        "Drink a glass of water.",
      ],
      question: "What do you need most today?",
      ending: "Even small care matters 💙",
    });
  }
});

/* ================= DAILY WALLE NOTE ================= */
app.post("/daily-note", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const ref = admin.firestore().collection("users").doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });

    const data = snap.data();
    const today = new Date().toISOString().split("T")[0];

    // 🔥 Agar aaj ka note already hai → turant bhejo
    if (data?.dailyNote?.date === today) {
      return res.json({ text: data.dailyNote.text });
    }

    // 🛟 Instant fallback (app fast rahe)
    const fallback =
      "I’m here with you today. Even a small pause can be kind to your mind 💙";

    // Client ko turant fallback bhej do
    res.json({ text: fallback });

    // 🔄 Background me AI generate karo
    const streak = data?.streak || 0;
    const mood = data?.lastMood || "normal";

    const prompt = `
You are WALLE, a warm emotional companion.

Write ONE short daily note for the user.

Context:
- Streak: ${streak}
- Mood: ${mood}

Rules:
- 2–3 lines only
- Human, emotional, gentle
- No medical advice
- Feel personal
`;

    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
        max_tokens: 120,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        },
        timeout: 7000,
      }
    );

    const text = r.data.choices[0].message.content.trim();

    await ref.set(
      {
        dailyNote: {
          date: today,
          text,
        },
      },
      { merge: true }
    );
  } catch (e) {
    console.error("DAILY NOTE ERROR:", e);
  }
});


/* =====================================================
   🔔 SEND NOTIFICATION + SAVE TO FIRESTORE (FINAL)
   ===================================================== */
app.post("/send", auth, async (req, res) => {
  try {
    const { token, title, body, screen, userId } = req.body;

    if (!token || !userId) {
      return res.status(400).json({ error: "token & userId required" });
    }

    // 1️⃣ SEND PUSH
    await admin.messaging().send({
      token,
      data: {
        title,
        body,
        screen: screen || "Home",
      },
      android: { priority: "high" },
    });


    // 2️⃣ 🔥 SAVE USER-WISE
    await admin.firestore()
      .collection("users")
      .doc(userId)
      .collection("notifications")
      .add({
        title,
        message: body,
        screen: screen || "Home",
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });



    res.json({ success: true });
  } catch (err) {
    console.error("❌ SEND ERROR:", err);
    res.status(500).json({ error: "Notification send failed" });
  }
});

const NUDGE_TEMPLATES = {
  soft: [
    { title: "Just a small check 💙", body: "One tiny step for your health today?" },
    { title: "WALLE here", body: "You don’t have to do everything. Just one thing." },
  ],
  care: [
    { title: "How are you feeling?", body: "It’s okay to slow down today." },
  ],
  emotional: [
    { title: "We miss you 💙", body: "Come back when you’re ready." },
  ],
  proud: [
    { title: "You’re doing great 🔥", body: "Your streak shows real care." },
  ],
};

function pickTemplate(tone) {
  const arr = NUDGE_TEMPLATES[tone];
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/* =====================================================
   🤖 AUTO NUDGE ENGINE (SMART – DUOLINGO STYLE)
   ===================================================== */

const DAY_MS = 24 * 60 * 60 * 1000;

function dateOnly(d = new Date()) {
  return d.toISOString().split("T")[0];
}

async function generateAINudge({ tone, timeOfDay, lastMood }) {
  const prompt = `
You are WALLE, a warm health companion.

Generate ONE short push notification.

Context:
- Tone: ${tone}
- Time: ${timeOfDay} (morning / afternoon / night)
- User last mood: ${lastMood || "unknown"}

Rules:
- 1 title line (max 40 chars)
- 1 body line (max 90 chars)
- No medical advice
- Human, caring, simple
- Do not repeat earlier style
- Feel natural, not robotic

Output JSON only:
{
  "title": "",
  "body": ""
}
`;

  const r = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: process.env.OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
      max_tokens: 120,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
      },
    }
  );

  const raw = r.data.choices[0].message.content;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Invalid AI nudge");

  return JSON.parse(match[0]);
}

async function runAutoNudge() {
  try {
    console.log("🤖 Smart Auto-nudge scan started...");

    const snap = await admin.firestore().collection("users").get();
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const todayStr = dateOnly(now);

    for (const doc of snap.docs) {
      try {
        const data = doc.data();

        const hour = now.getHours();

        // 🔔 Night task reminder (9–10 PM)
        if (hour >= 21 && hour <= 22) {
          const todayTask = data.todayTask;

          if (todayTask && todayTask.completed === false && data.fcmToken) {
            try {
              await admin.messaging().send({
                token: data.fcmToken,
                data: {
                  title: "⏰ Daily Task Pending",
                  body: "Your health task for today is still pending. Just 1 minute 💙",
                  screen: "DailyTask",
                },
                android: { priority: "high" },
              });

              await admin.firestore()
                .collection("users")
                .doc(doc.id)
                .collection("notifications")
                .add({
                  title: "⏰ Daily Task Pending",
                  message: "Your health task for today is still pending. Just 1 minute 💙",
                  screen: "DailyTask",
                  read: false,
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            } catch (err) {
              if (
                err.code === "messaging/registration-token-not-registered" ||
                err.code === "messaging/invalid-registration-token"
              ) {
                await admin.firestore().collection("users").doc(doc.id).set(
                  { fcmToken: admin.firestore.FieldValue.delete() },
                  { merge: true }
                );
              }
            }
          }
        }

        const token = data.fcmToken;
        if (!token) continue;

        const lastOpen = data.lastOpenDate;
        if (!lastOpen) continue;
        if (data.lastNudgeAt === todayStr) continue;

        const streak = data.streak || 0;

        const diffOpen = Math.floor((now - new Date(lastOpen)) / DAY_MS);
        const diffSymptom = data.lastSymptomAt
          ? Math.floor((now - new Date(data.lastSymptomAt)) / DAY_MS)
          : 999;
        const diffTask = data.lastTaskDoneAt
          ? Math.floor((now - new Date(data.lastTaskDoneAt)) / DAY_MS)
          : 999;

        let tone = null;
        if (diffOpen >= 3) tone = "emotional";
        else if (diffSymptom >= 3) tone = "care";
        else if (diffTask >= 2) tone = "soft";
        else if (streak >= 5) tone = "proud";

        if (!tone) continue;

        const preferred = data.preferredNudgeHour || 10;
        const dnd = data.doNotDisturb;
        const h = now.getHours();

        if (dnd) {
          if (h >= dnd.from || h < dnd.to) continue;
        }
        if (h !== preferred) continue;

        const timeOfDay =
          h < 12 ? "morning" : h < 18 ? "afternoon" : "night";

       let msg = pickTemplate(tone);

       // Sirf ~30% cases me AI call
       if (!msg || Math.random() < 0.3) {
         try {
           msg = await generateAINudge({
             tone,
             timeOfDay,
             lastMood: data.lastMood || "",
           });
         } catch (e) {
           msg = pickTemplate(tone);
         }
       }

       if (!msg) continue;


        await admin.messaging().send({
          token,
          data: {
            title: msg.title,
            body: msg.body,
            screen: "Home",
          },
          android: { priority: "high" },
        });


        await admin.firestore()
          .collection("users")
          .doc(doc.id)
          .collection("notifications")
          .add({
            title: msg.title,
            message: msg.body,
            screen: "Home",
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });


        await admin.firestore().collection("users").doc(doc.id).set(
          { lastNudgeAt: todayStr },
          { merge: true }
        );

      } catch (e) {
        console.log("⚠️ USER SKIPPED:", doc.id, e.message);
      }
    }
    } catch (e) {
        console.error("SMART AUTO NUDGE ERROR:", e);
      }
    }



// हर 6 घंटे
setInterval(runAutoNudge, 6 * 60 * 60 * 1000);

// Server start hote hi ek baar run
setTimeout(runAutoNudge, 20 * 1000);








app.get("/auto-nudge", async (req, res) => {
  await runAutoNudge();
  res.json({ status: "Auto nudge executed" });
});

async function processChatAI(userId, aiMsgId) {
  // 🛑 Prevent parallel AI calls for same user
  if (runningAI.has(userId)) {
    console.log("⏸️ AI already running for user:", userId);
    return;
  }

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

  // 🔹 SYSTEM PROMPT (LANGUAGE LOGIC STAYS HERE)
  const systemPrompt = `
You are WALLE, a caring health companion.

Rules:
- Never give medical diagnosis.
- Be warm, human, and supportive.
- If the user is sad, be gentle.
- If the user is doing well, encourage.
- Use past context naturally.

Language behavior:
- If the user writes in English, reply in English.
- If the user writes in Hindi, reply in Hindi.
- If the user writes in Hinglish, reply in Hinglish.
- Always mirror the user's language style.
`;

   const messages = [{ role: "system", content: systemPrompt }];

      snap.docs.reverse().forEach(doc => {
        const d = doc.data();
        if (d.text && d.status === "done") {
          messages.push({ role: d.role, content: d.text });
        }
      });

      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: process.env.OPENAI_MODEL,
          messages,
          temperature: 0.35,
          max_tokens: 250,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_KEY}`,
          },
          timeout: 7000,
        }
      );

      const answer = response.data.choices[0].message.content;

      await chatRef.doc(aiMsgId).update({
        text: answer,
        status: "done",
      });

    } catch (err) {
      console.error("CHAT AI ERROR:", err.message);

      await chatRef.doc(aiMsgId).update({
        text: "I’m here with you 💙",
        status: "done",
      });
    } finally {
      // ✅ VERY IMPORTANT
      runningAI.delete(userId);
    }
  }


/* ================= START SERVER ================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
