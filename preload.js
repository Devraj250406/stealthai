const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js');
const fs = require('fs');
const path = require('path');

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

// ─── Fallback Engine Logger ───────────────────────────────────────
function logFallback(msg) {
  try {
    const logPath = path.join(__dirname, 'stealth_fallback.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${msg}\n`);
    console.log(`[Fallback Engine] ${msg}`);
  } catch (e) {}
}

// ─── Stream Cancellation ──────────────────────────────────────────
let currentAbortController = null;
let isCancelled = false;

// ═══════════════════════════════════════════════════════════════════
//  MODEL REGISTRY — Central health tracking for all models
// ═══════════════════════════════════════════════════════════════════

const ModelRegistry = {
  gemini: {
    models: [
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', healthy: true, vision: true, errorCount: 0, successCount: 0, totalResponseTime: 0, lastError: null, cooldownUntil: 0 },
      { id: 'gemini-3.0-flash', displayName: 'Gemini 3 Flash', healthy: true, vision: true, errorCount: 0, successCount: 0, totalResponseTime: 0, lastError: null, cooldownUntil: 0 },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', healthy: true, vision: true, errorCount: 0, successCount: 0, totalResponseTime: 0, lastError: null, cooldownUntil: 0 },
      { id: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', healthy: true, vision: true, errorCount: 0, successCount: 0, totalResponseTime: 0, lastError: null, cooldownUntil: 0 },
      { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite', healthy: true, vision: true, errorCount: 0, successCount: 0, totalResponseTime: 0, lastError: null, cooldownUntil: 0 },
      { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', healthy: true, vision: true, errorCount: 0, successCount: 0, totalResponseTime: 0, lastError: null, cooldownUntil: 0 },
    ]
  },
  groq: {
    models: [
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', displayName: 'Llama 4 Scout 17B', healthy: true, vision: true, errorCount: 0, successCount: 0, totalResponseTime: 0, lastError: null, cooldownUntil: 0 },
      { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', displayName: 'Llama 4 Maverick 17B', healthy: true, vision: true, errorCount: 0, successCount: 0, totalResponseTime: 0, lastError: null, cooldownUntil: 0 },
      { id: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B', healthy: true, vision: false, errorCount: 0, successCount: 0, totalResponseTime: 0, lastError: null, cooldownUntil: 0 },
      { id: 'llama-3.1-8b-instant', displayName: 'Llama 3.1 8B', healthy: true, vision: false, errorCount: 0, successCount: 0, totalResponseTime: 0, lastError: null, cooldownUntil: 0 },
    ]
  }
};

function markModelUnhealthy(provider, modelId, error) {
  const entry = ModelRegistry[provider]?.models.find(m => m.id === modelId);
  if (!entry) return;
  const errStr = String(error).toLowerCase();
  
  entry.errorCount++;

  // Permanent failures
  if (errStr.includes('404') || errStr.includes('not_found') || errStr.includes('decommissioned') || errStr.includes('invalid_model') || errStr.includes('not found')) {
    entry.healthy = false;
    entry.lastError = 'permanently_unavailable';
    logFallback(`[CRITICAL] Marked ${modelId} as permanently unhealthy: ${errStr}`);
  }
  // Format / Invalid Request
  else if (errStr.includes('400') || errStr.includes('invalid_request_error') || errStr.includes('must be a string')) {
    entry.cooldownUntil = Date.now() + 300000; // 5 min cooldown for format issues to prevent loop crashing
    entry.lastError = 'invalid_request';
    logFallback(`[WARNING] Marked ${modelId} as format-unhealthy: ${errStr}`);
  }
  // Temporary rate-limit cooldown (60 seconds)
  else if (errStr.includes('429') || errStr.includes('rate') || errStr.includes('quota')) {
    entry.cooldownUntil = Date.now() + 60000;
    entry.lastError = 'rate_limited';
    logFallback(`[INFO] Rate limit on ${modelId}. Cooldown 60s.`);
  }
  // Server errors (500, 502, 503, 520) — cooldown 15 seconds
  else {
    entry.cooldownUntil = Date.now() + 15000;
    entry.lastError = errStr.slice(0, 100);
    logFallback(`[INFO] Server error on ${modelId}: ${entry.lastError}. Cooldown 15s.`);
  }
}

function isModelAvailable(entry) {
  if (!entry.healthy) return false;
  if (entry.cooldownUntil > Date.now()) return false;
  return true;
}

function getHealthyModels(provider, requireVision = false) {
  return ModelRegistry[provider].models.filter(m => {
    if (!isModelAvailable(m)) return false;
    if (requireVision && !m.vision) return false;
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════
//  CONTEXT-AWARE PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════

function buildSystemPrompt(context, hasImage) {
  let prompt = `You are an expert interview and exam assistant. The user is in a timed assessment.
CRITICAL RULES:
- NEVER output dense paragraphs. Use well-defined, easy-to-read bullet points.
- Be extremely concise and direct — the user is under time pressure.
- For conceptual questions: Provide clear definitions in bullet points.
- When asked for code: Provide the code in a markdown block, then a step-by-step approach in bullet points.
- ALWAYS conclude with Time Complexity and Space Complexity if applicable.`;

  if (hasImage) {
    prompt += `

SCREENSHOT ANALYSIS PROTOCOL:
1. OCR FIRST: Carefully read ALL text visible in the screenshot. Transcribe the exact question before answering.
2. IDENTIFY the question type: MCQ | Coding | DSA | Aptitude | Math | Technical | Competitive Programming.
3. SOLVE based on type:
   - MCQ: State the correct answer option FIRST (e.g., "Answer: B"), then explain why in 2-3 bullets.
   - Coding Question: Provide working code in a markdown block, then approach in bullet points.
   - DSA/Algorithm: Provide the optimal approach, working code, and Time/Space complexity.
   - Aptitude/Math: Show step-by-step solution. Bold the final answer.
   - Competitive Programming: Optimal solution handling all edge cases + complexity analysis.
   - Technical Interview: Concise, structured answer with key points.
4. If multiple questions are visible, solve ALL of them in order.
5. If the image is unclear, state what you can read and solve based on that.`;
  }

  if (context) {
    prompt += `\n\n--- USER BACKGROUND ---\n${context}\n--- END BACKGROUND ---`;
  }

  return prompt;
}

// ═══════════════════════════════════════════════════════════════════
//  IMAGE PREPROCESSING
// ═══════════════════════════════════════════════════════════════════

function preprocessImage(base64Input) {
  // Strip any data URL prefix to get raw base64
  let raw = base64Input;
  if (raw.startsWith('data:')) {
    raw = raw.replace(/^data:image\/\w+;base64,/, '');
  }
  return raw;
}

// ═══════════════════════════════════════════════════════════════════
//  STREAMING ENGINES (per-provider)
// ═══════════════════════════════════════════════════════════════════

async function executeGeminiStream(key, modelStr, isVision, messages, systemPrompt, onChunk) {
  isCancelled = false;
  currentAbortController = new AbortController();
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(key);

  const aiModel = genAI.getGenerativeModel({
    model: modelStr,
    systemInstruction: systemPrompt,
    generationConfig: { temperature: 0.3 }
  });

  const history = messages.slice(0, -1).map(m => {
    let parts = [{ text: m.content || "[Image Omitted]" }];
    if (m.image && isVision) {
      parts.push({
        inlineData: { data: preprocessImage(m.image), mimeType: 'image/jpeg' }
      });
    }
    return {
      role: m.role === 'user' ? 'user' : 'model',
      parts
    };
  });

  const latestMsg = messages[messages.length - 1];
  const promptParts = [];
  if (latestMsg.image && isVision) {
    promptParts.push({
      inlineData: { data: preprocessImage(latestMsg.image), mimeType: 'image/jpeg' }
    });
  }
  promptParts.push({ text: latestMsg.content || "[Image Omitted]" });

  const chat = aiModel.startChat({ history });
  const result = await chat.sendMessageStream(promptParts);

  for await (const chunk of result.stream) {
    if (isCancelled) break;
    onChunk(chunk.text());
  }
}

async function executeGroqStream(key, modelStr, isVision, messages, systemPrompt, onChunk) {
  return new Promise(async (resolve, reject) => {
    isCancelled = false;
    currentAbortController = new AbortController();
    const fetch = require('node-fetch');

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => {
        // If the model DOES NOT support vision, we MUST strip the image completely.
        // Sending an image_url object to a text-only model causes 400 'must be a string'.
        if (!isVision || !m.image) {
          return {
            role: m.role === 'model' ? 'assistant' : m.role,
            content: m.content || "[Image Omitted: Model does not support vision]"
          };
        }
        
        // Model DOES support vision AND we have an image
        const base64Data = m.image.startsWith('data:') ? m.image : `data:image/jpeg;base64,${m.image}`;
        return {
          role: m.role === 'model' ? 'assistant' : m.role,
          content: [
            { type: "text", text: m.content || "Analyze this image." },
            { type: "image_url", image_url: { url: base64Data } }
          ]
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

      stream.on('end', () => resolve());
      stream.on('error', (err) => {
        if (err.name === 'AbortError' || isCancelled) { resolve(); return; }
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  UNIFIED STREAM WITH FALLBACK — Cross-provider failover
// ═══════════════════════════════════════════════════════════════════

async function streamWithFallbackInternal({ geminiKey, groqKey, preferredProvider, preferredModel, messages, context, onChunk, onDone, onError }) {
  const hasImage = messages.some(m => m.image);
  const systemPrompt = buildSystemPrompt(context, hasImage);

  logFallback(`--- New Request Started ---`);
  logFallback(`Preferred: ${preferredProvider}/${preferredModel} | Has Image: ${hasImage}`);

  // Build the ordered fallback chain
  const primaryProvider = preferredProvider;
  const secondaryProvider = preferredProvider === 'gemini' ? 'groq' : 'gemini';

  const getModelScore = (m) => {
    const successRate = (m.successCount + m.errorCount) > 0 ? (m.successCount / (m.successCount + m.errorCount)) : 1;
    const avgResponseTime = m.successCount > 0 ? (m.totalResponseTime / m.successCount) : 1000;
    let score = 1000;
    score -= (m.errorCount * 200);
    score += (successRate * 500);
    score -= (avgResponseTime / 100);
    return score;
  };
  const sortModelsByHealth = (a, b) => getModelScore(b) - getModelScore(a);

  const chain = [];

  // 1. Try the user's selected model first (if healthy)
  const selectedEntry = ModelRegistry[primaryProvider]?.models.find(m => m.id === preferredModel);
  if (selectedEntry && isModelAvailable(selectedEntry)) {
    if (!hasImage || selectedEntry.vision) {
      chain.push({ provider: primaryProvider, model: preferredModel, vision: selectedEntry.vision });
    }
  }

  // 2. Add remaining healthy models from primary provider, sorted by health
  const primaryModels = getHealthyModels(primaryProvider, hasImage).filter(m => m.id !== preferredModel);
  primaryModels.sort(sortModelsByHealth);
  primaryModels.forEach(m => chain.push({ provider: primaryProvider, model: m.id, vision: m.vision }));

  // 3. Add healthy models from secondary provider (cross-provider fallback), sorted by health
  const secondaryModels = getHealthyModels(secondaryProvider, hasImage);
  secondaryModels.sort(sortModelsByHealth);
  secondaryModels.forEach(m => chain.push({ provider: secondaryProvider, model: m.id, vision: m.vision }));

  // 4. If image required but NO vision models are available, try text models as an absolute last resort.
  // The stream executors will cleanly strip the image so it doesn't crash the text models with a 400 error.
  if (chain.length === 0 && hasImage) {
    logFallback(`[WARNING] No healthy vision models available. Falling back to stripping image and using text models.`);
    const primaryTextModels = getHealthyModels(primaryProvider, false);
    primaryTextModels.sort(sortModelsByHealth);
    primaryTextModels.forEach(m => chain.push({ provider: primaryProvider, model: m.id, vision: false }));

    const secondaryTextModels = getHealthyModels(secondaryProvider, false);
    secondaryTextModels.sort(sortModelsByHealth);
    secondaryTextModels.forEach(m => chain.push({ provider: secondaryProvider, model: m.id, vision: false }));
  }

  if (chain.length === 0) {
    const errorMsg = 'All models are currently unavailable. Please check your API keys and try again.';
    logFallback(`[ABORT] ${errorMsg}`);
    onError(errorMsg);
    return;
  }

  // Walk the chain
  for (let i = 0; i < chain.length; i++) {
    const { provider, model, vision } = chain[i];
    const key = provider === 'gemini' ? geminiKey : groqKey;

    if (!key) {
      logFallback(`Skipping ${provider}/${model} - No API Key.`);
      continue;
    }

    try {
      logFallback(`Executing target -> Provider: ${provider} | Model: ${model}`);
      const startTime = Date.now();
      
      if (provider === 'gemini') {
        await executeGeminiStream(key, model, vision, messages, systemPrompt, onChunk);
      } else {
        await executeGroqStream(key, model, vision, messages, systemPrompt, onChunk);
      }
      
      const responseTime = Date.now() - startTime;
      const entry = ModelRegistry[provider]?.models.find(m => m.id === model);
      if (entry) {
        entry.successCount++;
        entry.totalResponseTime += responseTime;
      }

      // Success! We're done.
      logFallback(`Successfully completed stream using ${provider}/${model} in ${responseTime}ms.`);
      onDone();
      return;
    } catch (err) {
      if (err.name === 'AbortError' || isCancelled) {
        logFallback(`Stream aborted by user.`);
        onDone();
        return;
      }
      logFallback(`[ERROR] ${provider}/${model} failed: ${err.message}`);
      markModelUnhealthy(provider, model, err.message);
      // Loop continues to next model...
    }
  }

  // All models exhausted
  logFallback(`[FATAL] Exhausted all ${chain.length} models in the fallback chain.`);
  onError('All available models failed. Please check your API keys or try again later. Check stealth_fallback.log for details.');
}

// ═══════════════════════════════════════════════════════════════════
//  EXPOSE SECURE API TO RENDERER
// ═══════════════════════════════════════════════════════════════════

contextBridge.exposeInMainWorld('stealthAPI', {
  cancelStream: () => {
    isCancelled = true;
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
  },

  // ─── Model Registry Access ─────────────────────────────────────
  getModelRegistry: () => {
    return {
      gemini: ModelRegistry.gemini.models.map(m => ({
        id: m.id,
        displayName: m.displayName,
        healthy: isModelAvailable(m),
        vision: m.vision,
        lastError: m.lastError
      })),
      groq: ModelRegistry.groq.models.map(m => ({
        id: m.id,
        displayName: m.displayName,
        healthy: isModelAvailable(m),
        vision: m.vision,
        lastError: m.lastError
      }))
    };
  },

  // ─── Dynamic Model Discovery & Validation ──────────────────────
  discoverAndValidateModels: async (geminiKey, groqKey) => {
    const result = { gemini: [], groq: [] };

    // Gemini discovery
    if (geminiKey) {
      try {
        const fetch = require('node-fetch');
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
        if (response.ok) {
          const data = await response.json();
          const apiModels = data.models
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace('models/', ''));

          ModelRegistry.gemini.models.forEach(entry => {
            if (apiModels.includes(entry.id)) {
              entry.healthy = true;
              entry.lastError = null;
              entry.cooldownUntil = 0;
              result.gemini.push({ id: entry.id, displayName: entry.displayName, vision: entry.vision });
            } else {
              entry.healthy = false;
              entry.lastError = 'not_found_in_api';
            }
          });
        }
      } catch (e) {
        console.error('Gemini discovery failed:', e);
      }
    }

    // Groq discovery
    if (groqKey) {
      try {
        const fetch = require('node-fetch');
        const response = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'Authorization': `Bearer ${groqKey}` }
        });
        if (response.ok) {
          const data = await response.json();
          const apiModelIds = data.data.map(m => m.id);

          ModelRegistry.groq.models.forEach(entry => {
            if (apiModelIds.includes(entry.id)) {
              entry.healthy = true;
              entry.lastError = null;
              entry.cooldownUntil = 0;
              result.groq.push({ id: entry.id, displayName: entry.displayName, vision: entry.vision });
            } else {
              entry.healthy = false;
              entry.lastError = 'not_found_in_api';
            }
          });
        }
      } catch (e) {
        console.error('Groq discovery failed:', e);
      }
    }

    return result;
  },

  // ─── Unified Streaming with Cross-Provider Fallback ────────────
  streamWithFallback: (params) => {
    streamWithFallbackInternal(params);
  },

  // ─── Audio Transcription using Gemini ──────────────────────────
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

  // ─── IPC Listeners ─────────────────────────────────────────────
  onClickThroughState: (callback) => ipcRenderer.on('app:clickThroughState', callback),
  onAutoCapture: (callback) => ipcRenderer.on('app:triggerAutoCapture', (event, base64Image) => callback(base64Image)),
  onStealthMinimizeState: (callback) => ipcRenderer.on('app:stealthMinimizeState', callback),

  // ─── Markdown rendering ────────────────────────────────────────
  renderMarkdown: (text) => {
    try {
      return marked.parse(text || '');
    } catch {
      return `<p>${escapeHtml(text || '')}</p>`;
    }
  },

  // ─── App controls ──────────────────────────────────────────────
  setOpacity: (value) => ipcRenderer.invoke('app:setOpacity', value),
  closeApp: () => ipcRenderer.invoke('app:close'),
  getSources: () => ipcRenderer.invoke('app:getSources'),
  captureScreen: () => ipcRenderer.invoke('app:captureScreen'),

  // ─── Cleanup helper ────────────────────────────────────────────
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});
