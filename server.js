require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// 🔔 ADDED (NOTHING REMOVED)
const admin = require("firebase-admin");

const app = express();

// ✅ REQUIRED FOR RENDER (RATE LIMIT FIX)
app.set("trust proxy", 1);

// 🔥 TEST ROUTE — सबसे ऊपर (UNCHANGED)
app.get("/test", (req, res) => {
  res.json({ status: "Server running OK!" });
});

// 🔐 FIREBASE ADMIN INIT (ADDED ONLY)
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

// Security (UNCHANGED)
app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: '64kb' }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
  })
);

// API KEY Auth (UNCHANGED)
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No authorization header" });

  const token = authHeader.split(" ")[1];
  if (token !== process.env.BASIC_API_KEY)
    return res.status(401).json({ error: "Invalid API Key" });

  next();
}

// CHAT (UNCHANGED)
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

// SUMMARY (UNCHANGED)
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

// 🔔 SEND NOTIFICATION (ADDED ONLY – DATA-ONLY FCM)
app.post("/send", auth, async (req, res) => {
  try {
    const { token, title, body, screen } = req.body;

    if (!token) {
      return res.status(400).json({ error: "FCM token required" });
    }

    await admin.messaging().send({
      token,
      data: {
        title: title || "Daily Health Reminder",
        body: body || "Bro thoda paani pee lo 💧",
        screen: screen || "Home",
      },
      android: { priority: "high" },
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Notification send failed" });
  }
});

// START (UNCHANGED)
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
