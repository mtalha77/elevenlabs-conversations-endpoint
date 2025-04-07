import nodemailer from "nodemailer";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests allowed" });
  }

  const { conversationId } = req.body;

  if (!conversationId) {
    return res.status(400).json({ error: "Missing conversationId" });
  }

  const XI_API_KEY = process.env.ELEVENLABS_API_KEY;
  const audioUrl = `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}/audio`;

  try {
    // Fetch audio
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

    // Use arrayBuffer() instead of buffer() and convert to Buffer
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // Setup email
    const transporter = nodemailer.createTransport({
      service: "gmail", // or your SMTP provider
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      subject: "Your ElevenLabs Conversation Audio",
      text: "Attached is your conversation audio.",
      attachments: [
        {
          filename: `conversation-${conversationId}.mp3`,
          content: audioBuffer,
        },
      ],
    };

    // Send email
    await transporter.sendMail(mailOptions);

    return res.status(200).json({ message: "Email sent successfully" });
  } catch (error) {
    console.error("Error sending email:", error);
    return res
      .status(500)
      .json({ error: "Internal server error", message: error.message });
  }
}
