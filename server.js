require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

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

/* ================= CHAT ================= */
app.post("/chat", auth, async (req, res) => {
  try {
    const { message } = req.body;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a safe, helpful health assistant. Never give a diagnosis.",
          },
          { role: "user", content: message },
        ],
        temperature: 0.3,
        max_tokens: 400,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        },
      }
    );

    res.json({ answer: response.data.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch response" });
  }
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
    const { symptoms } = req.body;

    const text = symptoms
      .map((s) => `- ${s.text || ""}`)
      .join("\n");

    const prompt = `
User ke recent symptoms:
${text}

In symptoms ke base par 3 daily health tasks banao:

1. Body Task (physical care)
2. Mind Task (mental care)
3. Awareness Task (self reflection / journaling)

Rules:
- Har task ek line ka ho
- Medical diagnosis mat do
- Caring & supportive tone ho
- Aaj ke liye fresh ho (repeat na ho)

Output sirf JSON me do:
{
  "body": { "task": "", "reason": "" },
  "mind": { "task": "", "reason": "" },
  "awareness": { "task": "", "reason": "" }
}
`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL,
        messages: [
          { role: "system", content: "You generate safe daily health tasks." },
          { role: "user", content: prompt },
        ],
        temperature: 0.6,
        max_tokens: 300,
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` } }
    );

    const raw = response.data.choices[0].message.content;

    // 🔥 Sirf JSON part nikaalo
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Invalid JSON from AI");
    }

    const json = JSON.parse(match[0]);


    res.json(json);
  } catch (err) {
    console.error("DAILY TASK AI ERROR:", err);
    res.status(500).json({ error: "Daily task generation failed" });
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

/* =====================================================
   🤖 AUTO NUDGE ENGINE (SMART – DUOLINGO STYLE)
   ===================================================== */

const DAY_MS = 24 * 60 * 60 * 1000;

function dateOnly(d = new Date()) {
  return d.toISOString().split("T")[0];
}

const buckets = {
  soft: [
    "Bas 1 minute do, apne aaj ke haal ka update kar do 💙",
    "Aaj khud se pooch lo – body kaisi lag rahi hai?",
    "WALLE bas check-in chahta hai, aur kuch nahi."
  ],
  care: [
    "Tum theek ho na? WALLE yahin hai 🤍",
    "Health ko ignore karna aadat na ban jaye… isliye yaad dila rahe hain.",
    "Khud ka khayal lena bhi ek strength hai."
  ],
  emotional: [
    "Tum kahin kho gaye ho… WALLE wait kar raha hai.",
    "Kya sab theek chal raha hai? Tum important ho.",
    "Aaj bhi khud ko thoda sa time nahi doge?"
  ],
  proud: [
    "Tumhara streak grow kar raha hai – ye tumhari aadat ban rahi hai 👏",
    "Lagataar effort dikh raha hai. Proud of you!",
    "Self-care ab tumhari routine ban rahi hai."
  ]
};

function pickNonRepeat(list, lastKey) {
  const filtered = list.filter((_, i) => `${i}` !== lastKey);
  const idx = Math.floor(Math.random() * filtered.length);
  const msg = filtered[idx];
  const realIndex = list.indexOf(msg);
  return { msg, key: `${realIndex}` };
}

function decideTone(diffDays, streak) {
  if (streak >= 5) return "proud";
  if (diffDays >= 3) return "emotional";
  if (diffDays === 2) return "care";
  if (diffDays === 1) return "soft";
  return null;
}

async function runAutoNudge() {
  try {
    console.log("🤖 Smart Auto-nudge scan started...");

    const snap = await admin.firestore().collection("users").get();
    const now = new Date();
    const todayStr = dateOnly(now);

    for (const doc of snap.docs) {
      const data = doc.data();

      const token = data.fcmToken;
   const lastOpen = data.lastOpenDate;
   const lastSymptomAt = data.lastSymptomAt;
   const lastTaskDoneAt = data.lastTaskDoneAt;

   const lastNudgeAt = data.lastNudgeAt;
   const lastNudgeKey = data.lastNudgeKey;
   const streak = data.streak || 0;

   // ye dono rehne hi chahiye
   if (!token || !lastOpen) continue;
   if (lastNudgeAt === todayStr) continue;

   const diffOpen = Math.floor((now - new Date(lastOpen)) / DAY_MS);

   const diffSymptom = lastSymptomAt
     ? Math.floor((now - new Date(lastSymptomAt)) / DAY_MS)
     : 999;

   const diffTask = lastTaskDoneAt
     ? Math.floor((now - new Date(lastTaskDoneAt)) / DAY_MS)
     : 999;

   // 🔥 yahin ab real behavior se tone decide hoga
   let tone = null;

   if (diffOpen >= 3) tone = "emotional";        // app hi open nahi
   else if (diffSymptom >= 3) tone = "care";     // symptom ignore
   else if (diffTask >= 2) tone = "soft";        // task ignore
   else if (streak >= 5) tone = "proud";         // good habit

   if (!tone) continue;

      const { msg, key } = pickNonRepeat(buckets[tone], lastNudgeKey);

      await admin.messaging().send({
        token,
        data: {
          title: "WALLE 💙",
          body: msg,
          screen: "Home",
        },
        android: { priority: "high" },
      });

      await admin.firestore().collection("users").doc(doc.id).set(
        {
          lastNudgeAt: todayStr,
          lastNudgeKey: key,
        },
        { merge: true }
      );
    }
  } catch (e) {
    console.error("SMART AUTO NUDGE ERROR:", e);
  }
}

// हर 6 घंटे
setInterval(runAutoNudge, 6 * 60 * 60 * 1000);
setTimeout(runAutoNudge, 20 * 1000);


// 🔁 Har 6 ghante me chale
setInterval(runAutoNudge, 6 * 60 * 60 * 1000);

// Server start hote hi ek baar run
setTimeout(runAutoNudge, 20 * 1000);

app.get("/auto-nudge", async (req, res) => {
  await runAutoNudge();
  res.json({ status: "Auto nudge executed" });
});


/* ================= START SERVER ================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
