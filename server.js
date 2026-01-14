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


/* ================= START SERVER ================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
