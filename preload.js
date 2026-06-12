const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js');

// ─── Configure Marked with Syntax Highlighting ────────────────────
marked.use({
  renderer: {
    code(codeStr, lang) {
      const validLang = lang && hljs.getLanguage(lang) ? lang : null;
      let highlighted;
      try {
        highlighted = validLang
          ? hljs.highlight(codeStr, { language: validLang }).value
          : hljs.highlightAuto(codeStr).value;
      } catch {
        highlighted = escapeHtml(codeStr || '');
      }
      const langLabel = validLang ? `<span class="code-lang">${validLang}</span>` : '';
      return `<div class="code-block">${langLabel}<pre><code class="hljs${validLang ? ` language-${validLang}` : ''}">${highlighted}</code></pre></div>`;
    }
  },
  breaks: true,
  gfm: true
});

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Stream Cancellation ──────────────────────────────────────────
let currentAbortController = null;
let isCancelled = false;

// ─── Expose Secure API to Renderer ────────────────────────────────
contextBridge.exposeInMainWorld('stealthAPI', {
  cancelStream: () => {
    isCancelled = true;
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
  },

  // Gemini streaming (executed in preload using native Web Fetch)
  streamGemini: async ({ key, model, messages, context, onChunk, onDone, onError }) => {
    try {
      isCancelled = false;
      currentAbortController = new AbortController();
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(key);

      const baseInstruction = 'You are an expert interview assistant. The user is in a live interview. CRITICAL INSTRUCTIONS: 1. NEVER output dense paragraphs. Use well-defined, easy-to-read bullet points that the user can naturally read aloud to the interviewer. 2. For conceptual questions: Provide clear, easy-to-understand definitions in bullet points. 3. When asked for code: Provide the code in a markdown block, then provide a clear, step-by-step approach in bullet points that is detailed enough to fully satisfy an interviewer\'s expectations. 4. ALWAYS conclude with the Time Complexity and Space Complexity at the very end.';
      const systemInstruction = context
        ? `${baseInstruction}\n\n--- USER BACKGROUND ---\n${context}\n--- END BACKGROUND ---`
        : baseInstruction;

      const aiModel = genAI.getGenerativeModel({ model, systemInstruction });

      // Build history excluding the latest user message
      const history = messages.slice(0, -1).map(m => {
        let parts = [];
        if (m.image) {
          parts.push({
            inlineData: {
              data: m.image,
              mimeType: "image/jpeg"
            }
          });
        }
        parts.push({ text: m.content });
        return {
          role: m.role,
          parts: parts
        };
      });

      const latestMsg = messages[messages.length - 1];
      let promptParts = [];
      if (latestMsg.image) {
        promptParts.push({
          inlineData: {
            data: latestMsg.image,
            mimeType: "image/jpeg"
          }
        });
      }
      promptParts.push({ text: latestMsg.content });

      const chat = aiModel.startChat({ history });
      const result = await chat.sendMessageStream(promptParts);

      for await (const chunk of result.stream) {
        if (isCancelled) break;
        onChunk(chunk.text());
      }
      onDone();
    } catch (err) {
      if (err.name === 'AbortError') {
        onDone();
        return;
      }
      console.error(err);
      onError(err.message || 'Stream failed');
    }
  },

  streamGroq: ({ key, model, messages, context, onChunk, onDone, onError }) => {
    (async () => {
      try {
        isCancelled = false;
        currentAbortController = new AbortController();
        const fetch = require('node-fetch');
        
        let systemPrompt = "You are an expert interview assistant. The user is in a live interview. CRITICAL INSTRUCTIONS: 1. NEVER output dense paragraphs. Use well-defined, easy-to-read bullet points that the user can naturally read aloud to the interviewer. 2. For conceptual questions: Provide clear, easy-to-understand definitions in bullet points. 3. When asked for code: Provide the code in a markdown block, then provide a clear, step-by-step approach in bullet points that is detailed enough to fully satisfy an interviewer's expectations. 4. ALWAYS conclude with the Time Complexity and Space Complexity at the very end.";
        if (context) {
          systemPrompt += `\n\n--- USER BACKGROUND ---\n${context}\n--- END BACKGROUND ---`;
        }
        
        // Convert 'model' role to 'assistant' for Groq/OpenAI format
        const formattedMessages = [
          { role: 'system', content: systemPrompt },
          ...messages.map(m => ({
            role: m.role === 'model' ? 'assistant' : m.role,
            content: m.content
          }))
        ];

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model,
            messages: formattedMessages,
            temperature: 0.3,
            stream: true
          }),
          signal: currentAbortController.signal
        });

        if (!response.ok) {
          const errorData = await response.text();
          throw new Error(`Groq API Error: ${response.status} - ${errorData}`);
        }

        // Parse SSE stream
        const stream = response.body;
        stream.on('data', chunk => {
          if (isCancelled) return;
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;
              try {
                const data = JSON.parse(dataStr);
                if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
                  onChunk(data.choices[0].delta.content);
                }
              } catch (e) {
                // Ignore parse errors on incomplete chunks
              }
            }
          }
        });

        stream.on('end', () => {
          onDone();
        });
        
        stream.on('error', (err) => {
          if (err.name === 'AbortError' || isCancelled) {
            onDone();
            return;
          }
          onError(err.message);
        });

      } catch (error) {
        if (error.name === 'AbortError' || isCancelled) {
          onDone();
          return;
        }
        console.error('Groq streaming error:', error);
        onError(error.message || String(error));
      }
    })();
  },

  streamDeepSeek: ({ key, model, messages, context, onChunk, onDone, onError }) => {
    (async () => {
      try {
        isCancelled = false;
        currentAbortController = new AbortController();
        const fetch = require('node-fetch');
        
        let systemPrompt = "You are an expert interview assistant. The user is in a live interview. CRITICAL INSTRUCTIONS: 1. NEVER output dense paragraphs. Use well-defined, easy-to-read bullet points that the user can naturally read aloud to the interviewer. 2. For conceptual questions: Provide clear, easy-to-understand definitions in bullet points. 3. When asked for code: Provide the code in a markdown block, then provide a clear, step-by-step approach in bullet points that is detailed enough to fully satisfy an interviewer's expectations. 4. ALWAYS conclude with the Time Complexity and Space Complexity at the very end.";
        if (context) {
          systemPrompt += `\n\n--- USER BACKGROUND ---\n${context}\n--- END BACKGROUND ---`;
        }
        
        const formattedMessages = [
          { role: 'system', content: systemPrompt },
          ...messages.map(m => ({
            role: m.role === 'model' ? 'assistant' : m.role,
            content: m.content
          }))
        ];

        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model,
            messages: formattedMessages,
            temperature: 0.3,
            stream: true
          }),
          signal: currentAbortController.signal
        });

        if (!response.ok) {
          const errorData = await response.text();
          throw new Error(`DeepSeek API Error: ${response.status} - ${errorData}`);
        }

        const stream = response.body;
        stream.on('data', chunk => {
          if (isCancelled) return;
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;
              try {
                const data = JSON.parse(dataStr);
                if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
                  onChunk(data.choices[0].delta.content);
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          }
        });

        stream.on('end', () => {
          onDone();
        });
        
        stream.on('error', (err) => {
          if (err.name === 'AbortError' || isCancelled) {
            onDone();
            return;
          }
          onError(err.message);
        });

      } catch (error) {
        if (error.name === 'AbortError' || isCancelled) {
          onDone();
          return;
        }
        console.error('DeepSeek streaming error:', error);
        onError(error.message || String(error));
      }
    })();
  },

  // Audio Transcription using Gemini (Stealth Hybrid Capture)
  transcribeAudio: async (key, modelString, base64Audio) => {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(__dirname, 'audio-debug.log');
    
    try {
      fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] transcribeAudio called with model ${modelString}. Base64 length: ${base64Audio.length}\n`);
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({ model: modelString });
      
      const prompt = "You are a specialized transcription AI. Transcribe the spoken words in this audio clip exactly. Do not add any commentary, do not answer questions, and do not format with markdown. Just output the exact raw spoken text. If there is no human speech, output the exact word: [SILENCE]";
      
      const audioPart = {
        inlineData: {
          data: base64Audio,
          mimeType: "audio/webm"
        }
      };

      const result = await model.generateContent([prompt, audioPart]);
      const text = result.response.text().trim();
      
      fs.appendFileSync(logPath, `[SUCCESS] Output: ${text}\n`);
      return text;
    } catch (err) {
      fs.appendFileSync(logPath, `[ERROR] Transcription error: ${err.stack || err.message || err}\n`);
      console.error('Transcription error:', err);
      throw err;
    }
  },

  // Click-Through State Listener
  onClickThroughState: (callback) => ipcRenderer.on('app:clickThroughState', callback),

  // Stealth Minimize Icon Mode Listener
  onStealthMinimizeState: (callback) => ipcRenderer.on('app:stealthMinimizeState', callback),

  // Markdown rendering (runs in preload context with Node access)
  renderMarkdown: (text) => {
    try {
      return marked.parse(text || '');
    } catch {
      return `<p>${escapeHtml(text || '')}</p>`;
    }
  },

  // App controls
  setOpacity: (value) => ipcRenderer.invoke('app:setOpacity', value),
  closeApp: () => ipcRenderer.invoke('app:close'),
  getSources: () => ipcRenderer.invoke('app:getSources'),
  captureScreen: () => ipcRenderer.invoke('app:captureScreen'),

  // Cleanup helper
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});
