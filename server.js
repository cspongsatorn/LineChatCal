import express from 'express';
import axios from 'axios';
import vision from '@google-cloud/vision';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';

dotenv.config();

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ================== DB SECTION ==================
const db = new Database('./soExternalData.db');

// สร้างตารางถ้ายังไม่มี
db.prepare(`
  CREATE TABLE IF NOT EXISTS so_external_data (
    dept TEXT PRIMARY KEY,
    target REAL
  )
`).run();

// อ่านข้อมูลจากฐานข้อมูล
async function readSoExternalData() {
  const rows = db.prepare("SELECT dept, target FROM so_external_data").all();
  const result = {};
  rows.forEach(r => {
    result[r.dept] = r.target;
  });
  return result;
}

// เขียน/อัพเดตข้อมูล
async function writeSoExternalData(newData) {
  const stmt = db.prepare(`
    INSERT INTO so_external_data (dept, target)
    VALUES (@dept, @target)
    ON CONFLICT(dept) DO UPDATE SET target = excluded.target
  `);
  const insertMany = db.transaction((data) => {
    for (const [dept, target] of Object.entries(data)) {
      stmt.run({ dept, target });
    }
  });
  insertMany(newData);
}

// ฟังก์ชันประมวลผลคำสั่ง SET
async function processSetCommand(text) {
  if (!text.startsWith('SET ')) return null;

  const args = text.slice(4).trim();
  const pairs = args.split(/\s+/);

  let updated = {};
  pairs.forEach(pair => {
    const [key, value] = pair.split('=');
    if (key && value && !isNaN(value)) {
      updated[key] = Number(value);
    }
  });

  if (Object.keys(updated).length > 0) {
    await writeSoExternalData(updated);
    const latest = await readSoExternalData();
    return `อัพเดตเป้ารายวันสำเร็จ: ${JSON.stringify(latest)}`;
  } else {
    return 'รูปแบบคำสั่ง SET ไม่ถูกต้อง หรือไม่มีข้อมูลให้แก้ไข';
  }
}
// =================================================


// Google Vision Client
const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS)
});

// ฟังก์ชันดึงภาพจาก LINE
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

// ฟังก์ชันประมวลผลข้อความจาก OCR → สรุปยอด
async function parseSummary(text) {
  let lines = text
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const startIndex = lines.findIndex(l => /^S012-CMI/i.test(l) || /^Total$/i.test(l));
  if (startIndex === -1) return 'ไม่พบข้อมูลตาราง';
  lines = lines.slice(startIndex + 1);

  let data = [];
  for (let i = 0; i < lines.length; i++) {
    let dept = lines[i];
    if (/^[A-Z]{2}$/.test(dept)) {
      let posSo = parseFloat(lines[i + 1]?.replace(/,/g, '')) || 0;
      data.push({ dept, posSo });
    }
  }

  const fmt = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ดึงเป้าจาก DB
  const targets = await readSoExternalData();

  let message = `📊 สรุปยอดขายประจำวันที่ ${new Date().toLocaleDateString('th-TH')}\n`;
  for (const row of data) {
    let target = targets[row.dept] || 0;
    let diff = row.posSo - target;
    let diffSign = diff >= 0 ? '+' : '';
    message += `\n${row.dept} เป้ารายวัน : ${fmt(target)}\n`;
    message += `${row.dept} ทำได้ : ${fmt(row.posSo)}\n`;
    message += `Diff : ${diffSign}${fmt(diff)}\n`;
  }

  return message;
}

// ฟังก์ชันส่งข้อความกลับไปทาง LINE
async function replyMessage(replyToken, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: [{ type: 'text', text }]
  }, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` }
  });
}

// Webhook
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type === 'message') {
        if (event.message.type === 'image') {
          try {
            const imgBuffer = await getImageFromLine(event.message.id);
            const [result] = await visionClient.textDetection({ image: { content: imgBuffer } });
            const text = result.fullTextAnnotation ? result.fullTextAnnotation.text : '';
            const summary = await parseSummary(text);
            await replyMessage(event.replyToken, summary || 'ไม่พบข้อมูลในภาพค่ะ');
          } catch (err) {
            console.error('Error processing image:', err);
            await replyMessage(event.replyToken, 'เกิดข้อผิดพลาดในการประมวลผลภาพค่ะ');
          }
        } else if (event.message.type === 'text') {
          const response = await processSetCommand(event.message.text);
          if (response) {
            await replyMessage(event.replyToken, response);
          } else {
            await replyMessage(event.replyToken, 'กรุณาส่งภาพตารางยอด หรือคำสั่ง SET ค่ะ');
          }
        }
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
  console.log(`Server running on port ${PORT}`);
});