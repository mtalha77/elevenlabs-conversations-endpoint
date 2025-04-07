import nodemailer from "nodemailer";
import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests allowed" });
  }

  try {
          const elevenlabsSignature = req.headers["elevenlabs-signature"];
    if (!elevenlabsSignature) {
      return res.status(401).json({ error: "Missing ElevenLabs signature" });
    }

    const signatureParts = elevenlabsSignature.split(',');
    const timestamp = signatureParts.find(part => part.startsWith('t=')).substring(2);
    const signature = signatureParts.find(part => part.startsWith('v0=')).substring(3);

    const reqTimestamp = parseInt(timestamp) * 1000;
    const tolerance = Date.now() - 30 * 60 * 1000; 
    if (reqTimestamp < tolerance) {
      return res.status(403).json({ error: "Request expired" });
    }

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const message = `${timestamp}.${rawBody}`;
    const expectedSignature = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(message)
      .digest('hex');

    if (signature !== expectedSignature) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = typeof req.body === 'object' ? req.body : JSON.parse(req.body);
    
    if (payload.type !== "post_call_transcription") {
      return res.status(400).json({ error: "Unsupported webhook event type" });
    }

    const conversationId = payload.data?.conversation_id;
    if (!conversationId) {
      return res.status(400).json({ error: "Missing conversation_id in payload" });
    }

    const transcriptSummary = payload.data?.analysis?.transcript_summary || "No summary available.";

    let transcriptText = "CONVERSATION TRANSCRIPT:\n\n";
    if (payload.data?.transcript && Array.isArray(payload.data.transcript)) {
      payload.data.transcript.forEach((turn, index) => {
        transcriptText += `${turn.role.toUpperCase()}: ${turn.message}\n\n`;
      });
    } else {
      transcriptText += "Transcript not available.\n";
    }

    const XI_API_KEY = process.env.ELEVENLABS_API_KEY;
    const audioUrl = `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}/audio`;

    const response = await fetch(audioUrl, {
      method: "GET",
      headers: {
        "xi-api-key": XI_API_KEY,
      },
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: "Failed to fetch audio" });
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const callDuration = payload.data?.metadata?.call_duration_secs || "N/A";
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      subject: `Rockstar AI Recent Interaction Recording - ${new Date().toLocaleString()}`,
      text: `CALL SUMMARY:\n${transcriptSummary}\n\n` +
            `Call Duration: ${callDuration} seconds\n` +
            `Conversation ID: ${conversationId}\n\n` +
            `${transcriptText}`,
      attachments: [
        {
          filename: `conversation-${conversationId}.mp3`,
          content: audioBuffer,
        },
      ],
    };

    await transporter.sendMail(mailOptions);

    return res.status(200).json({ message: "Webhook processed successfully" });
  } catch (error) {
    console.error("Error processing webhook:", error);
    return res.status(200).json({ message: "Processed with errors" });
  }
}