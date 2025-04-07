import nodemailer from "nodemailer";
import crypto from "crypto";

// For Next.js API Routes - if you're using Pages Router
export const config = {
  api: {
    bodyParser: false, // Disable the default body parser
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests allowed" });
  }

  try {
    // For Next.js, get the raw body
    let rawBody;
    if (typeof req.body === "undefined" || req.body === null) {
      // If using the config above or App Router, we need to read the body as text
      if (req.text) {
        rawBody = await req.text();
      } else {
        // For older Next.js versions or other frameworks
        rawBody = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => resolve(Buffer.concat(chunks).toString()));
          req.on("error", reject);
        });
      }
    } else {
      // If body is already parsed
      rawBody =
        typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }

    // Check for signature header - CASE SENSITIVE as per documentation
    const elevenlabsSignature =
      req.headers["ElevenLabs-Signature"] ||
      req.headers["elevenlabs-signature"]; // Try both cases

    console.log("Headers received:", JSON.stringify(req.headers));

    if (!elevenlabsSignature) {
      return res.status(401).json({ error: "Missing ElevenLabs signature" });
    }

    console.log("Signature received:", elevenlabsSignature);

    const signatureParts = elevenlabsSignature.split(",");
    const timestampPart = signatureParts.find((part) => part.startsWith("t="));
    const signaturePart = signatureParts.find((part) => part.startsWith("v0="));

    if (!timestampPart || !signaturePart) {
      console.log("Invalid signature format:", elevenlabsSignature);
      return res.status(401).json({ error: "Invalid signature format" });
    }

    const timestamp = timestampPart.substring(2);
    const signature = signaturePart.substring(3);

    // Validate timestamp (prevent replay attacks)
    const reqTimestamp = parseInt(timestamp) * 1000;
    const tolerance = Date.now() - 30 * 60 * 1000; // 30 minutes tolerance
    if (reqTimestamp < tolerance) {
      return res.status(403).json({ error: "Request expired" });
    }

    // Validate signature - EXACTLY as in the example
    const message = `${timestamp}.${rawBody}`;
    const digest =
      "v0=" +
      crypto
        .createHmac("sha256", process.env.WEBHOOK_SECRET)
        .update(message)
        .digest("hex");

    console.log("Expected signature:", digest);
    console.log("Received signature:", "v0=" + signature);

    if ("v0=" + signature !== digest) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    // Parse the payload
    const payload = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;

    // Check if this is a post_call_transcription event
    if (payload.type !== "post_call_transcription") {
      return res.status(400).json({ error: "Unsupported webhook event type" });
    }

    const conversationId = payload.data?.conversation_id;
    if (!conversationId) {
      return res
        .status(400)
        .json({ error: "Missing conversation_id in payload" });
    }

    // Extract transcript summary for email body (if available)
    const transcriptSummary =
      payload.data?.analysis?.transcript_summary || "No summary available.";

    // Create transcript text from the messages
    let transcriptText = "CONVERSATION TRANSCRIPT:\n\n";
    if (payload.data?.transcript && Array.isArray(payload.data.transcript)) {
      payload.data.transcript.forEach((turn, index) => {
        transcriptText += `${turn.role.toUpperCase()}: ${turn.message}\n\n`;
      });
    } else {
      transcriptText += "Transcript not available.\n";
    }

    // Fetch audio using the conversation ID
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
        .status(200) // Still return 200 to keep webhook active
        .json({
          message: "Processed with errors",
          error: "Failed to fetch audio",
        });
    }

    // Convert audio to buffer
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // Setup email
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
      text:
        `CALL SUMMARY:\n${transcriptSummary}\n\n` +
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

    // Send email
    await transporter.sendMail(mailOptions);

    // Return 200 OK as required by ElevenLabs
    return res.status(200).json({ message: "Webhook processed successfully" });
  } catch (error) {
    console.error("Error processing webhook:", error);
    // Still return 200 to avoid webhook disablement, but log the error
    return res
      .status(200)
      .json({ message: "Processed with errors", error: error.message });
  }
}
