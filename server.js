import express from 'express';
import axios from 'axios';
import vision from '@google-cloud/vision';
import dotenv from 'dotenv';
import fs from 'fs/promises';

dotenv.config();

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// Google Vision Client
const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS)
});

// ไฟล์เก็บข้อมูลเป้ารายวัน
const dataFile = './soExternalData.json';

// ฟังก์ชันอ่านข้อมูล soExternalData จากไฟล์
async function readSoExternalData() {
  try {
    const content = await fs.readFile(dataFile, 'utf8');
    return JSON.parse(content);
  } catch {
    // ถ้าไฟล์ยังไม่มีหรืออ่านไม่ได้ ให้คืนค่าเป็น object ว่าง
    return {};
  }
}

// ฟังก์ชันเขียนข้อมูล soExternalData ลงไฟล์
async function writeSoExternalData(newData) {
  const content = JSON.stringify(newData, null, 2);
  await fs.writeFile(dataFile, content, 'utf8');
}

// ฟังก์ชันเช็คคำสั่ง SET และอัพเดตไฟล์ JSON
async function processSetCommand(text) {
  if (!text.startsWith('SET ')) return null;

  const args = text.slice(4).trim();
  const pairs = args.split(/\s+/);

  const currentData = await readSoExternalData();

  let updated = false;
  pairs.forEach(pair => {
    const [key, value] = pair.split('=');
    if (key && value && !isNaN(value)) {
      currentData[key] = Number(value);
      updated = true;
    }
  });

  if (updated) {
    await writeSoExternalData(currentData);
    return `อัพเดตเป้ารายวันสำเร็จ: ${JSON.stringify(currentData)}`;
  } else {
    return 'รูปแบบคำสั่ง SET ไม่ถูกต้อง หรือไม่มีข้อมูลให้แก้ไข';
  }
}

// ฟังก์ชันช่วย parse ตาราง
// ฟังก์ชันช่วย parse ตาราง
function parseReport3Columns(text) {
  const keys = [
    'OMCH3',
    'Rank',
    'POS + S/O'
  ];

  let rawCells = text
    .split(/\s+/)
    .map(c => c.trim())
    .filter(c => c !== '');

  console.log("OCR Lines:", rawCells);

  const headerIndex = rawCells.findIndex(
    c => c.toUpperCase().includes("OMCH3") || c.toUpperCase().includes("MCH3")
  );
  if (headerIndex === -1) return 'ไม่พบหัวตาราง OMCH3';

  let dataCells = rawCells.slice(headerIndex + keys.length);

  // ✅ แก้ไขให้รองรับหลาย code เป็นจุดเริ่มต้น
  const knownStores = [
    "VS","MA","FC","LT","PB","BR","HO","SA","KC","BD",
    "FD","PA","FT","HW","ET","DH","GD","HT","DW","OL",
    "PT","SR","AU","BC","BM","IT","PE","GG","MD","OD"
  ];

  const startIndex = dataCells.findIndex(c => knownStores.includes(c));
  if (startIndex === -1) return 'ไม่พบข้อมูลเริ่มต้นของสาขา/แผนก';
  dataCells = dataCells.slice(startIndex);

  // แปลงข้อมูลเป็น row
  let dataRows = [];
  let row = [];
  for (let i = 0; i < dataCells.length; i++) {
    const cell = dataCells[i];
    if (knownStores.includes(cell)) {
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



// ฟังก์ชัน format สรุปยอด
function formatSummaryReport(dataRows, soExternalData, reportDate) {
  console.log("dataRows:", dataRows);
  const group1 = ['HW', 'DW', 'DH', 'BM', 'BR', 'GG'];
  const group2 = ['PA', 'PB', 'PT', 'HT', 'GD'];

  function formatNumber(num) {
    if (Number.isInteger(num)) return num.toLocaleString('en-US');
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  let message = '';

  // ===== Group 1 =====
  message += `แผนก HW/DW/DH/BM/BR/GG ส่งยอดขาย\nประจำวันที่ ${reportDate}\n\n`;
  group1.forEach(dept => {
    const row = dataRows.find(r => r['OMCH3'] === dept);
    if (!row) return;
    const target = soExternalData[dept] || 0;
    const today = parseFloat(row['POS + S/O'].replace(/,/g, '')) || 0;
    const diff = today - target;

    message += `${dept} เป้ารายวัน : ${formatNumber(target)}\n`;
    message += `${dept} ทำได้ : ${formatNumber(today)}\n`;
    message += `Diff : ${diff >= 0 ? '+' : ''}${formatNumber(diff)}\n\n`;
  });

  message += `ยอดขายอันดับ 1-3 \n`;
  message += `วันที่ ${reportDate} \n`;
  message += `1. \n`;
  message += `2. \n`;
  message += `3. \n\n`;
  message += `\n-------------------------------\n\n`;

  // ===== Group 2 =====
  message += `แผนก PA/PB/PT/HT/GD ส่งยอดขาย\nประจำวันที่ ${reportDate}\n\n`;
  group2.forEach(dept => {
    const row = dataRows.find(r => r['OMCH3'] === dept);
    if (!row) return;
    const target = soExternalData[dept] || 0;
    const today = parseFloat(row['POS + S/O'].replace(/,/g, '')) || 0;
    const diff = today - target;

    message += `${dept} เป้ารายวัน : ${formatNumber(target)}\n`;
    message += `${dept} ทำได้ : ${formatNumber(today)}\n`;
    message += `Diff : ${diff >= 0 ? '+' : ''}${formatNumber(diff)}\n\n`;
  });

  message += `ยอดขายอันดับ 1-3 PA \n`;
  message += `วันที่ ${reportDate} \n`;
  message += `1. \n`;
  message += `2. \n`;
  message += `3. \n\n`;

  message += `ยอดขายอันดับ 1-3 PB \n`;
  message += `วันที่ ${reportDate} \n`;
  message += `1. \n`;
  message += `2. \n`;
  message += `3. \n\n`;

  return message;
}


// ฟังก์ชันส่งข้อความกลับ LINE
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
      if (event.type === 'message') {
        if (event.message.type === 'text') {
          // ตรวจสอบคำสั่ง SET
          const response = await processSetCommand(event.message.text);
          if (response !== null) {
            await replyMessage(event.replyToken, response);
            continue;
          } else {
            await replyMessage(event.replyToken, 'กรุณาส่งคำสั่งที่ถูกต้อง หรือส่งภาพตารางยอดค่ะ');
            continue;
          }
        } else if (event.message.type === 'image') {
          try {
            const imgBuffer = await getImageFromLine(event.message.id);
            const [result] = await visionClient.textDetection({ image: { content: imgBuffer } });
            const text = result.fullTextAnnotation ? result.fullTextAnnotation.text : '';

            const dataRows = parseReport3Columns(text);
            if (typeof dataRows === 'string') {
              await replyMessage(event.replyToken, dataRows);
              continue;
            }

            // อ่านข้อมูลเป้ารายวันจากไฟล์ JSON
            const soExternalData = await readSoExternalData();

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
