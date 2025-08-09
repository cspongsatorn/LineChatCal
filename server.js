import express from 'express';
import axios from 'axios';
import vision from '@google-cloud/vision';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// สร้าง Vision Client จาก ENV
const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS)
});

// ดึงรูปจาก LINE
async function getImageFromLine(messageId) {
  const res = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` },
    responseType: 'arraybuffer'
  });
  return res.data;
}

// วิเคราะห์ข้อความจากรูป
function parseSummary(text) {
  // แยกบรรทัด
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let summary = [];
  let date = '';

  lines.forEach((line, idx) => {
    if (line.includes('แผนก')) {
      const dept = line.replace('แผนก', '').trim();
      const today = parseInt(lines[idx+1].replace(/\D/g, ''), 10) || 0;
      const target = parseInt(lines[idx+2].replace(/\D/g, ''), 10) || 0;
      const diff = today - target;
      summary.push(`แผนก ${dept} ยอดวันนี้ ${today} ยอดที่ต้องการ ${target} เป้า/ขาดทุน ${diff} บาท`);
    }
    if (line.includes('วันที่')) {
      date = line;
    }
  });

  return `สรุปยอดประจำ${date}\n` + summary.join('\n');
}

// ส่งข้อความกลับ LINE
async function replyMessage(replyToken, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: [{ type: 'text', text }]
  }, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` }
  });
}

app.post('/webhook', async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'image') {
      try {
        const imgBuffer = await getImageFromLine(event.message.id);
        const [result] = await visionClient.textDetection({ image: { content: imgBuffer } });
        const text = result.fullTextAnnotation ? result.fullTextAnnotation.text : '';
        const summary = parseSummary(text);
        await replyMessage(event.replyToken, summary || 'ไม่พบข้อมูลในภาพค่ะ');
      } catch (err) {
        console.error(err);
        await replyMessage(event.replyToken, 'เกิดข้อผิดพลาดในการประมวลผลภาพค่ะ');
      }
    } else {
      await replyMessage(event.replyToken, 'กรุณาส่งภาพตารางยอดค่ะ');
    }
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
