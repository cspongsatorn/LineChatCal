import express from 'express';
import axios from 'axios';
import vision from '@google-cloud/vision';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// Google Vision Client
const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS)
});

// ===== ฟังก์ชันช่วย =====
function parseReport9Columns(text) {
  const keys = [
    'OMCH3',
    'Rank',
    'POS + S/O',
    'POS',
    'S/O',
    'Basket POS',
    'Basket S/O',
    'POS2',
    'S/O2'
  ];

  let rawCells = text
    .split(/\s+/)
    .map(c => c.trim())
    .filter(c => c !== '');

  const headerIndex = rawCells.indexOf('OMCH3');
  if (headerIndex === -1) return 'ไม่พบหัวตาราง OMCH3';

  let dataCells = rawCells.slice(headerIndex + keys.length);

  const startIndex = dataCells.indexOf('BR');
  if (startIndex === -1) return 'ไม่พบข้อมูลเริ่มต้น BR';
  dataCells = dataCells.slice(startIndex);

  let fixedCells = [];
  dataCells.forEach(cell => {
    if (cell.includes(' ')) {
      const parts = cell.split(' ').filter(c => c !== '');
      fixedCells.push(...parts);
    } else {
      fixedCells.push(cell);
    }
  });

  const knownStores = new Set(['HW', 'DW', 'DH', 'BM', 'PA', 'PB', 'HT', 'PT', 'GD', 'GG']);
  let dataRows = [];
  let row = [];
  for (let i = 0; i < fixedCells.length; i++) {
    const cell = fixedCells[i];
    if (knownStores.has(cell)) {
      if (row.length > 0) {
        while (row.length < keys.length) row.push('0');
        let obj = {};
        keys.forEach((k, idx) => {
          obj[k] = row[idx];
        });
        dataRows.push(obj);
        row = [];
      }
      row.push(cell);
    } else {
      row.push(cell);
    }
  }
  if (row.length > 0) {
    while (row.length < keys.length) row.push('0');
    let obj = {};
    keys.forEach((k, idx) => {
      obj[k] = row[idx];
    });
    dataRows.push(obj);
  }
  return dataRows;
}

function formatSummaryReport(dataRows, soExternalData, reportDate) {
  const group1 = ['HW', 'DW', 'DH', 'BM']; // เพิ่ม GG
  const group2 = ['PA', 'PB', 'HT', 'PT', 'GD'];

  function formatNumber(num) {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  let message = '';
  message += `แผนก HW/DW/DH/BM ส่งยอดขาย\nประจำวันที่ ${reportDate}\n\n`;
  group1.forEach(dept => {
    const row = dataRows.find(r => r['OMCH3'] === dept);
    if (!row) return;
    const target = soExternalData[dept] || 0;
    const today = parseFloat(row['POS'].replace(/,/g, '')) || 0;
    const diff = today - target;

    message += `${dept} เป้ารายวัน : ${formatNumber(target)}\n`;
    message += `${dept} ทำได้ : ${formatNumber(today)}\n`;
    message += `Diff : ${diff >= 0 ? '+' : ''}${formatNumber(diff)}\n\n`;
  });

  message += `---------------\n\n`;
  message += `แผนก PA/PB/HT/PT/GD ส่งยอดขาย\nประจำวันที่ ${reportDate}\n\n`;

  group2.forEach(dept => {
    const row = dataRows.find(r => r['OMCH3'] === dept);
    if (!row) return;
    const target = soExternalData[dept] || 0;
    const today = parseFloat(row['POS'].replace(/,/g, '')) || 0;
    const diff = today - target;

    message += `${dept} เป้ารายวัน : ${formatNumber(target)}\n`;
    message += `${dept} ทำได้ : ${formatNumber(today)}\n`;
    message += `Diff : ${diff >= 0 ? '+' : ''}${formatNumber(diff)}\n\n`;
  });

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

// Webhook
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'image') {
        try {
          const imgBuffer = await getImageFromLine(event.message.id);
          const [result] = await visionClient.textDetection({ image: { content: imgBuffer } });
          const text = result.fullTextAnnotation ? result.fullTextAnnotation.text : '';

          const dataRows = parseReport9Columns(text);
          if (typeof dataRows === 'string') {
            await replyMessage(event.replyToken, dataRows);
            continue;
          }

          // ตัวอย่าง S/O จากแหล่งอื่น (ควรดึงจาก DB หรือ API จริง)
          const soExternalData = {
            HW: 50000,
            DW: 30000,
            DH: 40000,
            BM: 25000,           
            PA: 15000,
            PB: 18000,
            HT: 17000,
            PT: 16000,
            GD: 14000
          };

          const reportDate = new Date().toLocaleDateString('th-TH');
          const summary = formatSummaryReport(dataRows, soExternalData, reportDate);

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
  console.log(`Server running on port ${PORT}`);
});
