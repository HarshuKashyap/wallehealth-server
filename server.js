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
    { title: "🩺 How are you feeling today?", body: "Bas 1 tap, batao aaj kaisa feel ho raha hai 🙂" },
    { title: "💬 Quick check", body: "Aaj body thodi better lag rahi hai ya same?" },
    { title: "🌤️ Morning check", body: "Good morning! Aaj ka mood kaisa hai?" },
    { title: "🤍 We care", body: "Aaj kuch discomfort feel ho raha hai?" },
    { title: "🧠 Mind & body", body: "Aaj stress zyada hai ya manageable?" },
    { title: "😊 Hey you", body: "Aaj thoda better feel ho raha hai?" },
    { title: "💭 Just asking", body: "Sab okay chal raha hai?" },
    { title: "🌼 One tap check", body: "Batao aaj ka haal" },
    { title: "⏱️ 30 sec check", body: "Sirf 30 sec, bas ek update" },
    { title: "🌱 Small habit", body: "Roz thoda sa khayal = big change" },
    { title: "🤗 Checking in", body: "Aaj khud ke liye time nikala?" },
    { title: "🔔 Gentle ping", body: "Bas ek soft check-in 💙" },
  ],

  care: [
    { title: "🤒 Any symptoms today?", body: "Chhoti si update help karegi 💙" },
    { title: "📋 Daily health log", body: "Aaj koi new symptom notice hua?" },
    { title: "🩻 Body update", body: "Pain, fever ya weakness? Batao" },
    { title: "🧾 Health reminder", body: "Symptoms track karna mat bhoolna 🙂" },
    { title: "💧 Water break", body: "Thoda paani pee lo, body thank you bolegi 😉" },
    { title: "🚰 Hydration check", body: "Last glass paani kab piya tha?" },
    { title: "🌿 Care time", body: "Body ka khayal rakho, thoda hydrate ho jao" },
    { title: "💊 Gentle reminder", body: "Medicine li ya nahi?" },
    { title: "🩺 Health matters", body: "Aaj doctor ke advice follow hui?" },
    { title: "📌 Care check", body: "Treatment routine on track hai?" },
    { title: "🛌 Body needs rest", body: "Thoda rest bhi healing ka part hai" },
    { title: "🌙 Sleep care", body: "Aaj time pe sone ka try karo" },
  ],

  emotional: [
    { title: "🤍 Honest check", body: "Aaj sach me kaise ho?" },
    { title: "🌸 Take a breath", body: "10 sec deep breath, abhi" },
    { title: "🧠 Mind check", body: "Thakan physical ya mental?" },
    { title: "🌤️ Mood check", body: "Aaj mood thoda upar ya neeche?" },
    { title: "⏳ Pause moment", body: "Thoda ruk ke body suno" },
    { title: "💭 Thought check", body: "Aaj ka din easy tha ya tough?" },
    { title: "🤝 Support check", body: "Kuch help chahiye?" },
    { title: "🌙 Peace check", body: "Thoda rest bhi zaroori hai" },
    { title: "🤍 Just here", body: "WALLE yahin hai" },
    { title: "🫶 Care note", body: "Tum important ho, health bhi" },
    { title: "🌈 Hope", body: "Kal better ho sakta hai" },
    { title: "💙 We’re with you", body: "Akele nahi ho, step by step" },
  ],

  proud: [
    { title: "🌟 Small progress", body: "Thoda better bhi progress hota hai" },
    { title: "💚 Healing takes time", body: "Tum sahi direction me ho" },
    { title: "🌈 Hope check", body: "Kal se better lag raha hai?" },
    { title: "🤍 Keep going", body: "You’re doing good, honestly" },
    { title: "👏 Proud of you", body: "Lagataar effort dikh raha hai" },
    { title: "🔥 Consistency", body: "Roz thoda thoda = big change" },
    { title: "🌱 Growth", body: "Self-care ab aadat ban rahi hai" },
    { title: "💪 Strong habit", body: "Tum apni health ko priority de rahe ho" },
    { title: "🌟 Well done", body: "Tum khud ke liye khade ho" },
    { title: "🤝 Trust", body: "Is journey me tum akela nahi" },
    { title: "🌈 Bright path", body: "Tum sahi raaste par ho" },
    { title: "💙 Respect", body: "Khud ka khayal rakhna strength hai" },
  ],
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
          title: msg.title,
          body: msg.body,
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


// Server start hote hi ek baar run
setTimeout(runAutoNudge, 20 * 1000);

app.get("/auto-nudge", async (req, res) => {
  await runAutoNudge();
  res.json({ status: "Auto nudge executed" });
});


/* ================= START SERVER ================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
