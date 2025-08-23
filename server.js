import express from 'express';
import axios from 'axios';
import vision from '@google-cloud/vision';
import dotenv from 'dotenv';
import fs from 'fs/promises';

dotenv.config();

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// vision client
const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS)
});

// อ่าน so_external.json
async function readSoExternalData() {
  try {
    const raw = await await fs.readFile('./so_external.json', 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error reading so_external.json", err);
    return {};
  }
}

// parser แบบง่ายจาก OCR
function parseSimpleTable(text) {
  const knownStores = new Set([
    "VS","MA","FC","LT","PB","BR","HO","SA","KC","BD",
    "FD","PA","FT","HW","ET","DH","GD","HT","DW","OL",
    "PT","SR","AU","BC","BM","IT","PE","GG","MD","OD"
  ]);

  let rawCells = text
    .split(/\s+/)
    .map(c => c.trim().replace(/[,]/g, "")) // ลบ comma
    .filter(c => c !== "");

  let dataRows = [];
  for (let i = 0; i < rawCells.length; i++) {
    const cell = rawCells[i];
    if (knownStores.has(cell)) {
      const mch3 = cell;
      const rank = rawCells[i + 1] || "0";
      const pos = rawCells[i + 2] || "0";

      dataRows.push({
        MCH3: mch3,
        Rank: rank,
        "POS + S/O": pos
      });

      i += 2;
    }
  }
  return dataRows;
}

// formatter สรุปผล
function formatSummaryReport(dataRows, soExternalData, reportDate) {
  if (!Array.isArray(dataRows) || dataRows.length === 0) return null;

  let grouped = {};

  for (const row of dataRows) {
    const dept = row.MCH3;
    const posValue = parseFloat(row["POS + S/O"]) || 0;

    if (!grouped[dept]) grouped[dept] = 0;
    grouped[dept] += posValue;
  }

  let output = [];
  const groups = [
    ["BR", "GG"],
    ["MD", "OD"],
    ["HW", "DW", "DH", "BM"],
    ["PA", "PB", "HT", "PT", "GD"]
  ];

  for (const group of groups) {
    const groupRows = [];
    for (const dept of group) {
      const target = soExternalData[dept] || 0;
      const actual = grouped[dept] || 0;
      const diff = actual - target;

      groupRows.push(
        `${dept} เป้ารายวัน : ${target.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n` +
        `${dept} ทำได้ : ${actual.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n` +
        `Diff : ${diff >= 0 ? "+" : ""}${diff.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
      );
    }
    if (groupRows.length > 0) {
      output.push(
        `แผนก ${group.join("/")} ส่งยอดขาย\nประจำวันที่ ${reportDate}\n\n${groupRows.join("\n\n")}`
      );
    }
  }

  return output.join("\n\n-------------------------------\n\n");
}

// LINE reply helper
async function replyMessage(replyToken, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: [{ type: 'text', text }]
  }, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` }
  });
}

// ดึงรูปจาก LINE
async function getImageFromLine(messageId) {
  const response = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${LINE_TOKEN}` }
  });
  return Buffer.from(response.data, 'binary');
}

// webhook handler
app.post('/webhook', async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'image') {
      try {
        const imgBuffer = await getImageFromLine(event.message.id);
        const [result] = await visionClient.textDetection({ image: { content: imgBuffer } });
        const text = result.fullTextAnnotation ? result.fullTextAnnotation.text : '';

        const dataRows = parseSimpleTable(text);
        if (!dataRows.length) {
          await replyMessage(event.replyToken, 'ไม่พบข้อมูลสรุปยอด');
          continue;
        }

        const soExternalData = await readSoExternalData();
        const reportDate = new Date().toLocaleDateString('th-TH');
        const summary = formatSummaryReport(dataRows, soExternalData, reportDate);

        await replyMessage(event.replyToken, summary || 'ไม่พบข้อมูลในภาพค่ะ');
      } catch (err) {
        console.error('Error processing image:', err);
        await replyMessage(event.replyToken, 'เกิดข้อผิดพลาดในการประมวลผลภาพค่ะ');
      }
    }
  }

  res.sendStatus(200);
});

app.listen(3000, () => console.log('Server running on port 3000'));
