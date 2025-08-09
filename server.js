import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import vision from "@google-cloud/vision";

const app = express();
app.use(bodyParser.json());

const LINE_TOKEN = process.env.LINE_TOKEN; // เอามาจาก LINE Developer
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS; // JSON key ของ Google Vision (stringify แล้วเก็บใน env)

const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(GOOGLE_CREDENTIALS)
});

// ฟังก์ชัน OCR ด้วย Google Vision API
async function ocrImage(imageBuffer) {
  const [result] = await visionClient.textDetection({ image: { content: imageBuffer } });
  return result.textAnnotations.length ? result.textAnnotations[0].description : "";
}

// ฟังก์ชันแปลงข้อความเป็นสรุป
function parseAndCalculate(text) {
  const date = new Date().toLocaleDateString("th-TH");
  const regex = /แผนก\s*(\S+).*?ยอดวันนี้\s*(\d+).*?ยอดที่ต้องการ\s*(\d+)/gs;
  let match;
  const lines = [];

  while ((match = regex.exec(text)) !== null) {
    const dep = match[1];
    const today = parseInt(match[2], 10);
    const target = parseInt(match[3], 10);
    const diff = today - target;
    lines.push(`แผนก ${dep} ยอดวันนี้ ${today} ยอดที่ต้องการ ${target} เป้า/ขาดทุน ${diff} บาท`);
  }

  return `สรุปยอดประจำวันที่ ${date}\n` + lines.join("\n");
}

// Webhook ของ LINE
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  for (let event of events) {
    if (event.message?.type === "image") {
      try {
        // ดึงไฟล์รูปจาก LINE
        const imageUrl = `https://api-data.line.me/v2/bot/message/${event.message.id}/content`;
        const imgRes = await axios.get(imageUrl, {
          headers: { Authorization: `Bearer ${LINE_TOKEN}` },
          responseType: "arraybuffer"
        });

        // OCR
        const text = await ocrImage(imgRes.data);

        // สรุปผล
        const summary = parseAndCalculate(text);

        // ตอบกลับใน LINE
        await axios.post(
          "https://api.line.me/v2/bot/message/reply",
          {
            replyToken: event.replyToken,
            messages: [{ type: "text", text: summary }]
          },
          { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
        );

      } catch (error) {
        console.error("Error processing image:", error);
      }
    }
  }
  res.send("OK");
});

app.listen(3000, () => console.log("Server running on port 3000"));
