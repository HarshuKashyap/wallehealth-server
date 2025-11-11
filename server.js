// WALLEHealthServer/server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ✅ Basic Security
app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: '64kb' }));

// ✅ Rate Limiter (to prevent abuse)
app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // limit each IP to 60 requests per minute
  })
);

// ✅ Auth Middleware
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ error: 'No authorization header' });
  const token = authHeader.split(' ')[1];
  if (token !== process.env.BASIC_API_KEY)
    return res.status(401).json({ error: 'Invalid API Key' });
  next();
}

//
// 🧠 1️⃣ Chatbot Endpoint (for AI health chat)
//
app.post('/chat', auth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message)
      return res.status(400).json({ error: 'Message is required' });

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a safe, helpful health assistant providing general medical advice only. Never provide prescriptions or diagnoses.',
          },
          { role: 'user', content: message },
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

    const reply = response.data.choices[0].message.content;
    const safeReply = `${reply}\n\n⚠️ Note: This is informational only, not a medical diagnosis. For emergencies, visit a hospital or doctor immediately.`;
    res.json({ answer: safeReply });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch response' });
  }
});

//
// 🩺 2️⃣ AI Health Summary Endpoint (Phase 5.3)
//
app.post('/symptom-summary', auth, async (req, res) => {
  try {
    const { symptoms } = req.body;
    if (!symptoms || symptoms.length === 0) {
      return res.status(400).json({ error: 'No symptom data provided' });
    }

    // Combine all symptom text for AI analysis
    const textData = symptoms
      .map((s) => `${s.symptom || ''} - ${s.notes || ''}`)
      .join('; ');

    // 🧠 Send to OpenAI API for summary
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a medical summary assistant. Analyze symptom history and generate a helpful summary (avoid diagnosis).',
          },
          {
            role: 'user',
            content: `Here is my recent symptom log:\n${textData}\n\nPlease give me a short health summary and possible wellness tips.`,
          },
        ],
        temperature: 0.4,
        max_tokens: 350,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        },
      }
    );

    const summary = response.data.choices[0].message.content;
    res.json({ summary });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'AI summary generation failed' });
  }
});

//
// ✅ 3️⃣ Server Listen
//
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ WALLEHealth Server running on port ${PORT}`));

//
// 📊 3️⃣ AI Health Analytics Endpoint (Phase 6)
//
app.post('/analytics-summary', auth, async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || data.length === 0) {
      return res.status(400).json({ error: 'No analytics data provided' });
    }

    // Calculate average symptoms per day
    const avgSymptoms =
      data.reduce((acc, curr) => acc + curr.symptoms, 0) / data.length;

    // Optional: Build text summary
    const textForAI = `Here’s the user’s symptom trend data for this week:\n${JSON.stringify(
      data,
      null,
      2
    )}\n\nPlease summarize this trend with advice for recovery.`;

    // 🧠 Send to OpenAI for AI-powered insights
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful health assistant. Analyze trends and provide general wellness insights (avoid giving medical diagnosis).',
          },
          { role: 'user', content: textForAI },
        ],
        temperature: 0.4,
        max_tokens: 350,
      },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` },
      }
    );

    const aiSummary = response.data.choices[0].message.content;

    // Combine AI message with data-based summary
    const finalSummary = `${aiSummary}\n\n📊 Your average symptoms/day: ${avgSymptoms.toFixed(
      1
    )}.`;

    res.json({ summary: finalSummary });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Analytics summary failed' });
  }
});
