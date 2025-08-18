import express from 'express';
import axios from 'axios';
import vision from '@google-cloud/vision';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';

dotenv.config();

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// Google Vision Client
const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS)
});

// ====================== DATABASE ======================
const db = new sqlite3.Database('./sales.db', (err) => {
  if (err) {
    console.error('❌ Error opening database:', err);
  } else {
    console.log('✅ Connected to SQLite');
    db.run(`
      CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dept TEXT,
        target REAL,
        actual REAL,
        date TEXT
      )
    `);
  }
});

// ฟังก์ชันบันทึกลง DB
function saveSales(dept, target, actual, date) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO sales (dept, target, actual, date) VALUES (?, ?, ?, ?)',
      [dept, target, actual, date],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

// ====================== LINE IMAGE ======================
async function getImageFromLine(messageId) {
  const res = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` },
      responseType: 'arraybuffer'
    }
  );
  return res.data;
}

// ====================== PARSE OCR ======================
function parseSummary(text) {
  let lines = text
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const startIndex = lines.findIndex(l => /^S012-CMI/i.test(l) || /^Total$/i.test(l));
  if (startIndex === -1) return 'ไม่พบข้อมูลตาราง';
  lines = lines.slice(startIndex + 1);

  const group1 = ['HW', 'DW', 'DH', 'BM'];
  const group2 = ['PA', 'PB', 'HT', 'PT', 'GD'];

  let data = [];

  for (let i = 0; i < lines.length; i++) {
    let dept = lines[i];
    if (/^[A-Z]{2}$/.test(dept)) {
      let posSo = parseFloat(lines[i + 1]?.replace(/,/g, '')) || 0;
      data.push({ dept, posSo });
    }
  }

  const fmt = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function summarizeGroup(name, depts) {
    let rows = data.filter(d => depts.includes(d.dept));
    let sum = rows.reduce((acc, r) => acc + r.posSo, 0);
    let msg = `\n📌 กลุ่ม ${name}\n`;
    rows.forEach(r => {
      msg += `${r.dept} : ${fmt(r.posSo)}\n`;
    });
    msg += `รวมกลุ่ม ${name} : ${fmt(sum)} บาท\n`;
    return msg;
  }

  let message = '📊 สรุปยอดขาย\n';
  message += summarizeGroup(1, group1);
  message += summarizeGroup(2, group2);

  // 📌 บันทึกลง DB ด้วยวันที่วันนี้
  const today = new Date().toISOString().split('T')[0];
  data.forEach(d => {
    saveSales(d.dept, 0, d.posSo, today).catch(err => console.error('DB Save error:', err));
  });

  return message;
}

// ====================== REPLY LINE ======================
async function replyMessage(replyToken, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: [{ type: 'text', text }]
  }, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` }
  });
}

// ====================== WEBHOOK ======================
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'image') {
        try {
          const imgBuffer = await getImageFromLine(event.message.id);
          const [result] = await visionClient.textDetection({ image: { content: imgBuffer } });
          const text = result.fullTextAnnotation ? result.fullTextAnnotation.text : '';
          const summary = parseSummary(text);
          await replyMessage(event.replyToken, summary || 'ไม่พบข้อมูลในภาพค่ะ');
        } catch (err) {
          console.error('Error processing image:', err);
          await replyMessage(event.replyToken, 'เกิดข้อผิดพลาดในการประมวลผลภาพค่ะ');
        }
      } else {
        await replyMessage(event.replyToken, 'กรุณาส่งภาพตารางยอดค่ะ');
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(200);
  }
});

const PORT = 10000 || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
