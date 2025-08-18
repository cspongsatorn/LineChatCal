import express from 'express';
import axios from 'axios';
import vision from '@google-cloud/vision';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

dotenv.config();

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// Google Vision Client
const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS)
});

// === SQLite Setup ===
let db;
(async () => {
  db = await open({
    filename: './soExternalData.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS so_external_data (
      dept TEXT PRIMARY KEY,
      target REAL
    )
  `);
})();

// อ่านค่า target จาก DB
async function readSoExternalData() {
  const rows = await db.all("SELECT dept, target FROM so_external_data");
  const result = {};
  rows.forEach(r => result[r.dept] = r.target);
  return result;
}

// เขียนค่า target ลง DB
async function writeSoExternalData(newData) {
  const stmt = await db.prepare(`
    INSERT INTO so_external_data (dept, target)
    VALUES (?, ?)
    ON CONFLICT(dept) DO UPDATE SET target = excluded.target
  `);
  for (const [dept, target] of Object.entries(newData)) {
    await stmt.run(dept, target);
  }
  await stmt.finalize();
}

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

  // โหลด target จาก DB
  const targets = await readSoExternalData();

  const fmt = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function summarizeGroup(name, depts) {
    let rows = data.filter(d => depts.includes(d.dept));
    let sum = rows.reduce((acc, r) => acc + r.posSo, 0);
    let msg = `\n📌 กลุ่ม ${name}\n`;
    rows.forEach(r => {
      let target = targets[r.dept] || 0;
      msg += `${r.dept} : ${fmt(r.posSo)} / ${fmt(target)}\n`;
    });
    msg += `รวมกลุ่ม ${name} : ${fmt(sum)} บาท\n`;
    return msg;
  }

  let message = '📊 สรุปยอดขาย\n';
  message += summarizeGroup(1, group1);
  message += summarizeGroup(2, group2);

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
        } else if (event.message.type === 'text' && event.message.text.startsWith('set ')) {
          try {
            // ตัวอย่าง: "set HW 1000"
            const parts = event.message.text.split(' ');
            if (parts.length === 3) {
              const dept = parts[1].toUpperCase();
              const target = parseFloat(parts[2]);
              if (!isNaN(target)) {
                await writeSoExternalData({ [dept]: target });
                await replyMessage(event.replyToken, `✅ ตั้งค่าเป้า ${dept} = ${target}`);
              } else {
                await replyMessage(event.replyToken, 'รูปแบบไม่ถูกต้อง เช่น set HW 1000');
              }
            }
          } catch (err) {
            console.error('Error setting target:', err);
            await replyMessage(event.replyToken, 'เกิดข้อผิดพลาดในการตั้งค่าเป้าหมาย');
          }
        } else {
          await replyMessage(event.replyToken, 'กรุณาส่งภาพตารางยอด หรือพิมพ์ set DEPT ค่า');
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(200); // ตอบ 200 เพื่อไม่ให้ LINE retry
  }
});

const PORT = 10000 || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
