const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

async function run() {
  try {
    // Generate a dummy silent audio/webm base64
    const base64Audio = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChyXQfPz7XyAAAAAAAIeBAkKFgQRChwEAAICwBwgAAICAoQIAAAEDAAAABAIAAAEEAAABBAwAAAQYAAAEEA==";
    const key = process.env.GEMINI_API_KEY || 'AIzaSyA_...'; // Even if invalid, we want to see the error

    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = "You are a specialized transcription AI. Output exactly what you hear.";
    const audioPart = { inlineData: { data: base64Audio, mimeType: "audio/webm" } };

    const result = await model.generateContent([prompt, audioPart]);
    console.log("Success:", result.response.text());
  } catch (err) {
    console.log("Error:", err.message);
  }
}
run();
