// WALLEHealthServer/server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: '64kb' }));

// rate limit (avoid abuse)
app.use(rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // limit each IP to 60 requests per minute
}));

// simple auth middleware
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No authorization header' });
  const token = authHeader.split(' ')[1];
  if (token !== process.env.BASIC_API_KEY) return res.status(401).json({ error: 'Invalid API Key' });
  next();
}

// Chatbot endpoint
app.post('/chat', auth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: process.env.OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'You are a safe, helpful health assistant providing general advice only.' },
        { role: 'user', content: message }
      ],
      temperature: 0.3,
      max_tokens: 400
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
      }
    });

    const reply = response.data.choices[0].message.content;
    const safeReply = `${reply}\n\n⚠️ Note: This is informational only, not a medical diagnosis. For emergencies, visit a hospital or doctor immediately.`;
    res.json({ answer: safeReply });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch response' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ WALLEHealth Server running on port ${PORT}`));
