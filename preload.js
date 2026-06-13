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

  getValidGeminiModels: async (key) => {
    try {
      const fetch = require('node-fetch');
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }
      const data = await response.json();
      return data.models
        .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
        .map(m => ({
          id: m.name.replace('models/', ''),
          displayName: m.displayName || m.name.replace('models/', '')
        }));
    } catch (e) {
      console.error('Failed to fetch Gemini models:', e);
      return [];
    }
  },

  // Gemini streaming (executed in preload using native Web Fetch)
  streamGemini: async ({ key, model, messages, context, onChunk, onDone, onError }) => {
    const executeStream = async (modelStr) => {
      isCancelled = false;
      currentAbortController = new AbortController();
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(key);

      const baseInstruction = 'You are an expert interview assistant. The user is in a live interview. CRITICAL INSTRUCTIONS: 1. NEVER output dense paragraphs. Use well-defined, easy-to-read bullet points that the user can naturally read aloud to the interviewer. 2. For conceptual questions: Provide clear, easy-to-understand definitions in bullet points. 3. When asked for code: Provide the code in a markdown block, then provide a clear, step-by-step approach in bullet points that is detailed enough to fully satisfy an interviewer\'s expectations. 4. ALWAYS conclude with the Time Complexity and Space Complexity at the very end.';
      const systemInstruction = context
        ? `${baseInstruction}\n\n--- USER BACKGROUND ---\n${context}\n--- END BACKGROUND ---`
        : baseInstruction;

      const aiModel = genAI.getGenerativeModel({
        model: modelStr,
        systemInstruction,
        generationConfig: { temperature: 0.3 }
      });

      const history = messages.slice(0, -1).map(m => {
        let parts = [{ text: m.content }];
        if (m.image) {
          const base64Data = m.image.replace(/^data:image\/\w+;base64,/, '');
          parts.push({
            inlineData: { data: base64Data, mimeType: 'image/jpeg' }
          });
        }
        return {
          role: m.role === 'user' ? 'user' : 'model',
          parts
        };
      });

      const latestMsg = messages[messages.length - 1];
      const promptParts = [];
      if (latestMsg.image) {
        const base64Data = latestMsg.image.replace(/^data:image\/\w+;base64,/, '');
        promptParts.push({
          inlineData: { data: base64Data, mimeType: 'image/jpeg' }
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
    };

    try {
      await executeStream(model);
    } catch (err) {
      if (err.name === 'AbortError' || isCancelled) {
        onDone();
        return;
      }
      onError(err.message || 'Stream failed');
    }
  },

  streamGroq: ({ key, model, messages, context, onChunk, onDone, onError }) => {
    (async () => {
      const executeStream = async (modelStr) => {
        return new Promise(async (resolve, reject) => {
          isCancelled = false;
          currentAbortController = new AbortController();
          const fetch = require('node-fetch');
          
          let systemPrompt = "You are an expert interview assistant. The user is in a live interview. CRITICAL INSTRUCTIONS: 1. NEVER output dense paragraphs. Use well-defined, easy-to-read bullet points that the user can naturally read aloud to the interviewer. 2. For conceptual questions: Provide clear, easy-to-understand definitions in bullet points. 3. When asked for code: Provide the code in a markdown block, then provide a clear, step-by-step approach in bullet points that is detailed enough to fully satisfy an interviewer's expectations. 4. ALWAYS conclude with the Time Complexity and Space Complexity at the very end.";
          if (context) {
            systemPrompt += `\n\n--- USER BACKGROUND ---\n${context}\n--- END BACKGROUND ---`;
          }
          
          const formattedMessages = [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => {
              if (m.image) {
                const base64Data = m.image.startsWith('data:') ? m.image : `data:image/jpeg;base64,${m.image}`;
                return {
                  role: m.role === 'model' ? 'assistant' : m.role,
                  content: [
                    { type: "text", text: m.content || "Analyze this image." },
                    { type: "image_url", image_url: { url: base64Data } }
                  ]
                };
              }
              return {
                role: m.role === 'model' ? 'assistant' : m.role,
                content: m.content
              };
            })
          ];

          try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                model: modelStr,
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
                  } catch (e) {}
                }
              }
            });

            stream.on('end', () => {
              onDone();
              resolve();
            });
            
            stream.on('error', (err) => {
              if (err.name === 'AbortError' || isCancelled) {
                onDone();
                resolve();
                return;
              }
              reject(err);
            });
          } catch (err) {
            reject(err);
          }
        });
      };

      try {
        await executeStream(model);
      } catch (error) {
        if (error.name === 'AbortError' || isCancelled) {
          onDone();
          return;
        }
        const fallbackModel = 'llama-3.3-70b-versatile';
        if (model !== fallbackModel) {
          console.warn(`Groq model ${model} failed, falling back to ${fallbackModel}`, error);
          try {
            await executeStream(fallbackModel);
          } catch (fallbackErr) {
            console.error('Groq fallback error:', fallbackErr);
            onError(fallbackErr.message || String(fallbackErr));
          }
        } else {
          console.error('Groq streaming error:', error);
          onError(error.message || String(error));
        }
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

  // Auto Capture Listener
  onAutoCapture: (callback) => ipcRenderer.on('app:triggerAutoCapture', (event, base64Image) => callback(base64Image)),

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
