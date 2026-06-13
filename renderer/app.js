/* ═══════════════════════════════════════════════════════════════════
   StealthAI — Renderer Application Logic
   Manages chat, hybrid audio capture, context, settings, and UI.
   ═══════════════════════════════════════════════════════════════════ */

// ─── DOM References ────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {
  // Chat
  chatMessages:    $('#chat-messages'),
  chatInput:       $('#chat-input'),
  btnSend:         $('#btn-send'),
  btnStop:         $('#btn-stop'),
  btnNewChat:      $('#btn-new-chat'),
  autoScrollCheck: $('#auto-scroll-check'),

  // Transcript
  btnListen:          $('#btn-listen'),
  audioSourceSelect:  $('#audio-source-select'),
  audioDeviceSelect:  $('#audio-device-select'),
  btnRefreshDevices:  $('#btn-refresh-devices'),
  audioMeterFill:     $('#audio-meter-fill'),
  transcriptFeed:     $('#transcript-feed'),
  btnSendTranscript:  $('#btn-send-transcript'),

  // Context
  contextTextarea: $('#context-textarea'),
  btnUploadFile:   $('#btn-upload-file'),
  fileInput:       $('#file-input'),
  contextCharCount:$('#context-char-count'),

  // Settings
  apiKeyInput:  $('#api-key-input'),
  modelSelect:  $('#model-select'),
  btnClearAll:  $('#btn-clear-all'),

  // Titlebar
  opacitySlider: $('#opacity-slider'),
  btnHide:       $('#btn-hide'),
  btnClose:      $('#btn-close'),
};

// ─── Application State ────────────────────────────────────────────
const state = {
  messages: [],         // { role: 'user'|'model', content: string }
  isStreaming: false,
  streamBuffer: '',     // accumulates streamed markdown
  isListening: false,   // mic speech recognition active
  isTranscribing: false,// transcript panel recording
  transcriptText: '',   // accumulated transcript
  systemAudioStream: null,
  audioContext: null,
  audioAnalyser: null,
  meterAnimId: null,
  pendingScreenshot: null, // base64 string
  screenshotHistory: [],   // last 10 screenshots
};

// ─── Storage Keys ──────────────────────────────────────────────────
const KEYS = {
  MESSAGES: 'stealthai_messages',
  CONTEXT:  'stealthai_context',
  API_KEY:  'stealthai_apikey',
  MODEL:    'stealthai_model',
};

// ═══════════════════════════════════════════════════════════════════
//  TAB MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

function initTabs() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#panel-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
//  CHAT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

function loadChatHistory() {
  try {
    const saved = localStorage.getItem(KEYS.MESSAGES);
    if (saved) {
      state.messages = JSON.parse(saved);
      state.messages.forEach(msg => renderMessage(msg.role, msg.content, false));
      scrollToBottom();
    }
  } catch { /* ignore corrupt data */ }
}

function saveChatHistory() {
  try {
    localStorage.setItem(KEYS.MESSAGES, JSON.stringify(state.messages));
  } catch { /* storage full — silently fail */ }
}

function clearChat() {
  window.stealthAPI.cancelStream();
  state.isStreaming = false;
  state.streamBuffer = '';
  DOM.btnSend.disabled = false;
  DOM.btnSend.style.display = 'block';
  if (DOM.btnStop) DOM.btnStop.style.display = 'none';
  
  state.messages = [];
  localStorage.removeItem(KEYS.MESSAGES);
  DOM.chatMessages.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">◆</div>
      <p>Ask anything. Responses stream in real-time.</p>
      <p class="empty-hint">Tip: Paste your resume in the Context tab first.</p>
    </div>`;
}

function clearEmptyState() {
  const empty = DOM.chatMessages.querySelector('.empty-state');
  if (empty) empty.remove();
}

function renderMessage(role, content, animate = true) {
  clearEmptyState();

  const wrapper = document.createElement('div');
  wrapper.className = `message ${role === 'user' ? 'user' : 'ai'}`;
  if (!animate) wrapper.style.animation = 'none';

  const header = document.createElement('div');
  header.className = 'message-header';
  header.textContent = role === 'user' ? '⟩ You' : '◆ StealthAI';

  const body = document.createElement('div');
  body.className = 'message-body';

  if (role === 'user') {
    body.textContent = content;
  } else {
    body.innerHTML = window.stealthAPI.renderMarkdown(content);
  }

  wrapper.appendChild(header);
  wrapper.appendChild(body);
  DOM.chatMessages.appendChild(wrapper);

  return body;
}

function createStreamingMessage() {
  clearEmptyState();

  const wrapper = document.createElement('div');
  wrapper.className = 'message ai';

  const header = document.createElement('div');
  header.className = 'message-header';
  header.textContent = '◆ StealthAI';

  const body = document.createElement('div');
  body.className = 'message-body streaming-cursor';
  body.innerHTML = '';

  wrapper.appendChild(header);
  wrapper.appendChild(body);
  DOM.chatMessages.appendChild(wrapper);

  return body;
}

function scrollToBottom() {
  if (DOM.autoScrollCheck.checked) {
    DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
  }
}

async function sendMessage() {
  const text = DOM.chatInput.value.trim();
  if (!text || state.isStreaming) return;

  const provider = document.getElementById('provider-select').value;
  const geminiKey = DOM.apiKeyInput.value.trim();
  const groqKey = document.getElementById('groq-api-key-input').value.trim();

  // Need at least one key
  if (!geminiKey && !groqKey) {
    showError('Please enter at least one API key (Gemini or Groq) in the Config tab.');
    return;
  }

  // Add user message
  const msgObj = { role: 'user', content: text };
  const currentScreenshot = state.pendingScreenshot;
  if (currentScreenshot) {
    msgObj.image = currentScreenshot;
  }
  state.messages.push(msgObj);
  
  // Custom render for user message with image attached
  const wrapper = document.createElement('div');
  wrapper.className = 'message user';
  
  const header = document.createElement('div');
  header.className = 'message-header';
  header.textContent = 'You';
  
  const body = document.createElement('div');
  body.className = 'message-body';
  
  if (currentScreenshot) {
    const imgElement = document.createElement('img');
    imgElement.src = currentScreenshot.startsWith('data:') ? currentScreenshot : `data:image/jpeg;base64,${currentScreenshot}`;
    imgElement.style.maxWidth = '100%';
    imgElement.style.borderRadius = '8px';
    imgElement.style.marginBottom = '8px';
    body.appendChild(imgElement);
  }
  
  const textDiv = document.createElement('div');
  textDiv.textContent = text;
  body.appendChild(textDiv);
  
  wrapper.appendChild(header);
  wrapper.appendChild(body);
  DOM.chatMessages.appendChild(wrapper);
  
  state.pendingScreenshot = null; // reset for next msg
  
  // Clear image preview
  const previewArea = document.getElementById('image-preview-area');
  if (previewArea) { previewArea.innerHTML = ''; previewArea.style.display = 'none'; }
  
  DOM.chatInput.value = '';
  autoResizeInput();
  scrollToBottom();
  saveChatHistory();

  // Start streaming
  state.isStreaming = true;
  state.streamBuffer = '';
  DOM.btnSend.disabled = true;
  DOM.btnSend.style.display = 'none';
  if (DOM.btnStop) DOM.btnStop.style.display = 'block';

  const streamBody = createStreamingMessage();
  scrollToBottom();

  function finishStream(body) {
    body.classList.remove('streaming-cursor');
    const modelResponse = state.streamBuffer;
    state.messages.push({ role: 'model', content: modelResponse });
    saveChatHistory();
    state.isStreaming = false;
    state.streamBuffer = '';
    DOM.btnSend.disabled = false;
    DOM.btnSend.style.display = 'block';
    if (DOM.btnStop) DOM.btnStop.style.display = 'none';
    
    // Save to screenshot history if this was a screenshot message
    if (currentScreenshot) {
      saveToScreenshotHistory(currentScreenshot, text, modelResponse);
    }
  }

  // Use the unified fallback engine
  window.stealthAPI.streamWithFallback({
    geminiKey,
    groqKey,
    preferredProvider: provider,
    preferredModel: DOM.modelSelect.value,
    messages: state.messages,
    context: DOM.contextTextarea.value.trim(),
    onChunk: (chunk) => {
      state.streamBuffer += chunk;
      
      let renderText = state.streamBuffer;
      const backtickCount = (renderText.match(/```/g) || []).length;
      if (backtickCount % 2 !== 0) {
        renderText += '\n```';
      }
      
      streamBody.innerHTML = window.stealthAPI.renderMarkdown(renderText);
      scrollToBottom();
    },
    onDone: () => {
      finishStream(streamBody);
    },
    onError: (error) => {
      if (state.streamBuffer) {
        finishStream(streamBody);
      } else {
        streamBody.innerHTML = `<span style="color:var(--danger)">Error: ${error}</span>`;
        state.isStreaming = false;
        DOM.btnSend.disabled = false;
        DOM.btnSend.style.display = 'block';
        if (DOM.btnStop) DOM.btnStop.style.display = 'none';
      }
      showError(error);
    }
  });
}

// ─── Screenshot History ──────────────────────────────────────────
const SCREENSHOT_HISTORY_KEY = 'stealthai_screenshot_history';

function saveToScreenshotHistory(image, prompt, answer) {
  try {
    const history = JSON.parse(localStorage.getItem(SCREENSHOT_HISTORY_KEY) || '[]');
    // Create a small thumbnail (just store a truncated version to save space)
    const thumbnail = image.length > 5000 ? image.substring(0, 5000) : image;
    history.unshift({
      timestamp: Date.now(),
      thumbnail,
      fullImage: image,
      prompt,
      answer: answer.substring(0, 500) // truncate answer for storage
    });
    // Keep only last 10
    while (history.length > 10) history.pop();
    localStorage.setItem(SCREENSHOT_HISTORY_KEY, JSON.stringify(history));
    renderScreenshotHistory();
  } catch (e) {
    console.warn('Failed to save screenshot history:', e);
  }
}

function renderScreenshotHistory() {
  const container = document.getElementById('screenshot-history');
  if (!container) return;
  const history = JSON.parse(localStorage.getItem(SCREENSHOT_HISTORY_KEY) || '[]');
  if (history.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  container.innerHTML = '<div class="screenshot-history-label">Recent Screenshots</div><div class="screenshot-history-strip"></div>';
  const strip = container.querySelector('.screenshot-history-strip');
  history.forEach((entry, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'screenshot-thumb';
    thumb.title = `${new Date(entry.timestamp).toLocaleTimeString()} — Click to re-analyze`;
    const img = document.createElement('img');
    img.src = entry.fullImage.startsWith('data:') ? entry.fullImage : `data:image/jpeg;base64,${entry.fullImage}`;
    thumb.appendChild(img);
    thumb.addEventListener('click', () => {
      state.pendingScreenshot = entry.fullImage;
      DOM.chatInput.value = entry.prompt || 'Solve the problem in this screenshot.';
      autoResizeInput();
      sendMessage();
    });
    strip.appendChild(thumb);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  HYBRID AUDIO CAPTURE
// ═══════════════════════════════════════════════════════════════════

// ─── Transcript Panel Recording ────────────────────────────────────

let transcriptStream = null;
let whisperPipeline = null;
let whisperContext = null;
let whisperProcessor = null;
let whisperInterval = null;

async function toggleTranscription() {
  state.isTranscribing = !state.isTranscribing;

  if (state.isTranscribing) {
    DOM.btnListen.classList.add('active');
    DOM.btnListen.querySelector('.rec-label').textContent = 'Loading AI...';
    
    try {
      if (!whisperPipeline) {
        addTranscriptEntry('[SYSTEM: Downloading local Whisper AI (~40MB). Please wait...]', false);
        const transformers = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
        whisperPipeline = await transformers.pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
        addTranscriptEntry('[SYSTEM: Local AI ready! Listening...]', false);
      }

      DOM.btnListen.querySelector('.rec-label').textContent = 'Listening…';

      if (DOM.audioSourceSelect.value === 'system') {
        transcriptStream = await startSystemAudioCapture();
      } else {
        const constraints = { audio: true };
        const selectedDevice = DOM.audioDeviceSelect.value;
        if (selectedDevice) {
          constraints.audio = { deviceId: { exact: selectedDevice } };
        }
        transcriptStream = await navigator.mediaDevices.getUserMedia(constraints);
        setupAudioAnalyser(transcriptStream);
      }

      if (!transcriptStream) throw new Error('Could not start audio stream.');

      whisperContext = new AudioContext({ sampleRate: 16000 });
      const source = whisperContext.createMediaStreamSource(transcriptStream);
      whisperProcessor = whisperContext.createScriptProcessor(4096, 1, 1);
      
      let audioBuffer = [];
      
      whisperProcessor.onaudioprocess = (e) => {
        if (state.isTranscribing) {
          audioBuffer.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        }
      };

      // Connect to processor, and processor to destination (required for WebAudio API to fire events)
      const gainNode = whisperContext.createGain();
      gainNode.gain.value = 0; // Mute output so it doesn't feedback
      source.connect(whisperProcessor);
      whisperProcessor.connect(gainNode);
      gainNode.connect(whisperContext.destination);

      // Process chunks every 5 seconds locally
      whisperInterval = setInterval(async () => {
        if (!state.isTranscribing || audioBuffer.length === 0) return;
        
        // Concatenate buffers
        const totalLength = audioBuffer.reduce((acc, curr) => acc + curr.length, 0);
        const concatenated = new Float32Array(totalLength);
        let offset = 0;
        for (const array of audioBuffer) {
          concatenated.set(array, offset);
          offset += array.length;
        }
        
        // Reset buffer for the next chunk
        audioBuffer = [];
        
        try {
          const result = await whisperPipeline(concatenated);
          const transcript = result?.text?.trim();
          if (transcript && transcript.length > 2) {
            addTranscriptEntry(transcript, false);
            state.transcriptText += (state.transcriptText ? '\n' : '') + transcript;
            DOM.btnSendTranscript.disabled = false;
          }
        } catch (err) {
          console.error('Whisper processing error:', err);
        }
      }, 5000);

    } catch (err) {
      showError(err.message);
      state.isTranscribing = false;
      DOM.btnListen.classList.remove('active');
      DOM.btnListen.querySelector('.rec-label').textContent = 'Start Listening';
    }
  } else {
    // Stop transcribing
    if (whisperInterval) clearInterval(whisperInterval);
    if (whisperProcessor) whisperProcessor.disconnect();
    if (whisperContext) whisperContext.close();
    
    if (transcriptStream) {
      transcriptStream.getTracks().forEach(t => t.stop());
      transcriptStream = null;
    }
    
    DOM.btnListen.classList.remove('active');
    DOM.btnListen.querySelector('.rec-label').textContent = 'Start Listening';
    stopAudioMeter();
  }
}

function addTranscriptEntry(text, isInterim) {
  // Remove empty state
  const empty = DOM.transcriptFeed.querySelector('.empty-state');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = `transcript-entry${isInterim ? ' interim' : ''}`;

  const time = new Date();
  const timeStr = time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  entry.innerHTML = `<span class="transcript-time">${timeStr}</span><span class="transcript-text">${text}</span>`;
  DOM.transcriptFeed.appendChild(entry);
  DOM.transcriptFeed.scrollTop = DOM.transcriptFeed.scrollHeight;

  return entry;
}



// ─── System Audio Capture via desktopCapturer ──────────────────────

async function startSystemAudioCapture() {
  try {
    // Use getDisplayMedia to capture system audio
    // On macOS, this shows a permission dialog
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { width: 1, height: 1 } // Minimal video (required to get audio)
    });

    // Stop video tracks — we only need audio
    stream.getVideoTracks().forEach(t => t.stop());

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      showError('No system audio available. Install BlackHole for full system audio capture.');
      return null;
    }

    state.systemAudioStream = stream;
    setupAudioAnalyser(stream);
    return stream;
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showError('Screen capture permission denied. Required for system audio.');
    } else {
      showError(`System audio capture failed: ${err.message}`);
    }
    return null;
  }
}

function stopSystemAudioCapture() {
  if (state.systemAudioStream) {
    state.systemAudioStream.getTracks().forEach(t => t.stop());
    state.systemAudioStream = null;
  }
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
    state.audioAnalyser = null;
  }
}

// ─── Audio Level Meter ─────────────────────────────────────────────

async function startAudioMeter() {
  try {
    let stream;

    if (DOM.audioSourceSelect.value === 'system') {
      stream = await startSystemAudioCapture();
      if (!stream) return;
    } else {
      // Get mic stream for level metering
      const constraints = { audio: true };
      const selectedDevice = DOM.audioDeviceSelect.value;
      if (selectedDevice) {
        constraints.audio = { deviceId: { exact: selectedDevice } };
      }
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    }

    setupAudioAnalyser(stream);
  } catch (err) {
    console.warn('Audio meter failed:', err);
  }
}

function setupAudioAnalyser(stream) {
  if (state.audioContext) {
    state.audioContext.close();
  }

  state.audioContext = new AudioContext();
  state.audioAnalyser = state.audioContext.createAnalyser();
  state.audioAnalyser.fftSize = 256;
  state.audioAnalyser.smoothingTimeConstant = 0.7;

  const source = state.audioContext.createMediaStreamSource(stream);
  source.connect(state.audioAnalyser);

  updateMeter();
}

function updateMeter() {
  if (!state.audioAnalyser || !state.isTranscribing) {
    DOM.audioMeterFill.style.width = '0%';
    return;
  }

  const data = new Uint8Array(state.audioAnalyser.frequencyBinCount);
  state.audioAnalyser.getByteFrequencyData(data);

  const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
  const level = Math.min(100, (avg / 128) * 100);
  DOM.audioMeterFill.style.width = `${level}%`;

  state.meterAnimId = requestAnimationFrame(updateMeter);
}

function stopAudioMeter() {
  if (state.meterAnimId) {
    cancelAnimationFrame(state.meterAnimId);
    state.meterAnimId = null;
  }
  DOM.audioMeterFill.style.width = '0%';
  stopSystemAudioCapture();
}

// ─── Audio Device Enumeration ──────────────────────────────────────

async function enumerateAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    DOM.audioDeviceSelect.innerHTML = '<option value="">System Default</option>';
    audioInputs.forEach(device => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `Microphone ${DOM.audioDeviceSelect.options.length}`;
      DOM.audioDeviceSelect.appendChild(opt);
    });
    
    // Force the custom dropdown to refresh its visual label
    DOM.audioDeviceSelect.dispatchEvent(new Event('change'));
  } catch (err) {
    console.warn('Failed to enumerate audio devices:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  CONTEXT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

function initContext() {
  // Load saved context
  const saved = localStorage.getItem(KEYS.CONTEXT);
  if (saved) {
    DOM.contextTextarea.value = saved;
    updateCharCount();
  }

  // Auto-save on change
  DOM.contextTextarea.addEventListener('input', () => {
    localStorage.setItem(KEYS.CONTEXT, DOM.contextTextarea.value);
    updateCharCount();
  });

  // File upload
  DOM.btnUploadFile.addEventListener('click', () => DOM.fileInput.click());
  DOM.fileInput.addEventListener('change', handleFileUpload);
}

function updateCharCount() {
  const len = DOM.contextTextarea.value.length;
  DOM.contextCharCount.textContent = `${len.toLocaleString()} chars`;
}

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target.result;
    DOM.contextTextarea.value = DOM.contextTextarea.value
      ? DOM.contextTextarea.value + '\n\n' + text
      : text;
    localStorage.setItem(KEYS.CONTEXT, DOM.contextTextarea.value);
    updateCharCount();
  };
  reader.readAsText(file);
  DOM.fileInput.value = ''; // Reset for re-upload
}

// ═══════════════════════════════════════════════════════════════════
//  SETTINGS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

function initSettings() {
  const groqKeyInput = document.getElementById('groq-api-key-input');
  const providerSelect = document.getElementById('provider-select');
  const groqContainer = document.getElementById('api-key-container-groq');
  const geminiContainer = document.getElementById('api-key-container-gemini');
  const groqModels = document.getElementById('groq-models');
  const geminiModels = document.getElementById('gemini-models');

  // Load saved settings
  const savedKey = localStorage.getItem(KEYS.API_KEY);
  if (savedKey) DOM.apiKeyInput.value = savedKey;

  const savedGroqKey = localStorage.getItem('stealth_groq_api_key');
  if (savedGroqKey) groqKeyInput.value = savedGroqKey;

  const savedProvider = localStorage.getItem('stealth_provider') || 'groq';
  providerSelect.value = savedProvider;

  const savedModel = localStorage.getItem(KEYS.MODEL);
  if (savedModel) DOM.modelSelect.value = savedModel;

  function updateProviderUI() {
    const provider = providerSelect.value;
    localStorage.setItem('stealth_provider', provider);
    
    if (provider === 'groq') {
      groqContainer.style.display = 'block';
      geminiContainer.style.display = 'none';
      groqModels.style.display = 'block';
      geminiModels.style.display = 'none';
      if (!DOM.modelSelect.value.includes('llama')) {
        DOM.modelSelect.value = 'llama-3.3-70b-versatile';
        localStorage.setItem(KEYS.MODEL, DOM.modelSelect.value);
      }
    } else {
      groqContainer.style.display = 'none';
      geminiContainer.style.display = 'block';
      groqModels.style.display = 'none';
      geminiModels.style.display = 'block';
      if (!DOM.modelSelect.value.includes('gemini')) {
        DOM.modelSelect.value = 'gemini-2.5-pro';
        localStorage.setItem(KEYS.MODEL, DOM.modelSelect.value);
      }
    }
    
    DOM.modelSelect.dispatchEvent(new Event('change'));
  }

  // ─── Startup Model Discovery ─────────────────────────────────
  async function runModelDiscovery() {
    const geminiKey = DOM.apiKeyInput.value.trim();
    const groqKey = groqKeyInput.value.trim();
    if (!geminiKey && !groqKey) return;

    const result = await window.stealthAPI.discoverAndValidateModels(geminiKey, groqKey);

    // Update Gemini dropdown dynamically
    if (result.gemini.length > 0) {
      geminiModels.innerHTML = '';
      result.gemini.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.displayName;
        geminiModels.appendChild(opt);
      });
      geminiModels.label = 'Gemini Models (Validated)';
    }

    // Update Groq dropdown — hide unhealthy models
    if (result.groq.length > 0) {
      const validGroqIds = result.groq.map(m => m.id);
      Array.from(groqModels.querySelectorAll('option')).forEach(opt => {
        if (!validGroqIds.includes(opt.value)) {
          opt.style.display = 'none';
          opt.disabled = true;
        } else {
          opt.style.display = 'block';
          opt.disabled = false;
        }
      });
      groqModels.label = 'Groq Models (Validated)';
    }

    // Re-check if current selection is still valid
    const provider = providerSelect.value;
    if (provider === 'gemini' && result.gemini.length > 0) {
      const validIds = result.gemini.map(m => m.id);
      if (!validIds.includes(DOM.modelSelect.value)) {
        DOM.modelSelect.value = validIds[0];
        localStorage.setItem(KEYS.MODEL, validIds[0]);
      }
    }
    if (provider === 'groq' && result.groq.length > 0) {
      const validIds = result.groq.map(m => m.id);
      if (!validIds.includes(DOM.modelSelect.value)) {
        DOM.modelSelect.value = validIds[0];
        localStorage.setItem(KEYS.MODEL, validIds[0]);
      }
    }

    DOM.modelSelect.dispatchEvent(new Event('change'));
  }

  providerSelect.addEventListener('change', updateProviderUI);
  updateProviderUI(); // init run

  // Run discovery on startup
  runModelDiscovery();

  // Auto-save on change + re-discover
  DOM.apiKeyInput.addEventListener('input', () => {
    localStorage.setItem(KEYS.API_KEY, DOM.apiKeyInput.value.trim());
    runModelDiscovery();
  });

  groqKeyInput.addEventListener('input', () => {
    localStorage.setItem('stealth_groq_api_key', groqKeyInput.value.trim());
    runModelDiscovery();
  });

  DOM.modelSelect.addEventListener('change', () => {
    localStorage.setItem(KEYS.MODEL, DOM.modelSelect.value);
  });

  // Clear all data
  DOM.btnClearAll.addEventListener('click', () => {
    localStorage.clear();
    clearChat();
    DOM.apiKeyInput.value = '';
    groqKeyInput.value = '';
    DOM.contextTextarea.value = '';
    updateCharCount();
    state.transcriptText = '';
    DOM.transcriptFeed.innerHTML = '<div class="empty-state small"><p>Live transcript will appear here.</p></div>';
    DOM.btnSendTranscript.disabled = true;
  });

  // Render screenshot history on load
  renderScreenshotHistory();
}

// ═══════════════════════════════════════════════════════════════════
//  UI CONTROLS
// ═══════════════════════════════════════════════════════════════════

function initUI() {
  // Opacity slider
  DOM.opacitySlider.addEventListener('input', (e) => {
    window.stealthAPI.setOpacity(e.target.value / 100);
  });

  // Hide button
  DOM.btnHide.addEventListener('click', () => {
    window.stealthAPI.setOpacity(0); // Will effectively hide
  });

  // Close button
  DOM.btnClose.addEventListener('click', () => {
    window.stealthAPI.closeApp();
  });

  // Auto-Capture Listener (Silent Screenshot)
  if (window.stealthAPI && window.stealthAPI.onAutoCapture) {
    window.stealthAPI.onAutoCapture((base64Image) => {
      // Set the pending screenshot
      state.pendingScreenshot = base64Image;
      // Pre-fill prompt if empty
      if (!DOM.chatInput.value.trim()) {
        DOM.chatInput.value = "Solve the problem in this screenshot. Provide step-by-step approach and code if necessary.";
      }
      autoResizeInput();
      
      // Update UI to show image is attached (briefly, before auto-send clears it)
      const previewArea = document.getElementById('image-preview-area');
      if (previewArea) {
        const preview = document.createElement('img');
        preview.src = base64Image;
        previewArea.innerHTML = '';
        previewArea.appendChild(preview);
        previewArea.style.display = 'block';
      }

      // Automatically send
      sendMessage();
    });
  }

  // Auto-resize textarea
  DOM.chatInput.addEventListener('input', autoResizeInput);

  // Send button
  DOM.btnSend.addEventListener('click', sendMessage);
  if (DOM.btnStop) {
    DOM.btnStop.addEventListener('click', () => {
      window.stealthAPI.cancelStream();
    });
  }

  // Keyboard shortcuts
  DOM.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === 'Escape' && state.isStreaming) {
      // TODO: abort streaming
    }
  });

  // Handle Image Pasting
  DOM.chatInput.addEventListener('paste', (e) => {
    const items = (e.clipboardData || window.clipboardData).items;
    for (let index in items) {
      const item = items[index];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = (event) => {
          // Convert data URL to raw Base64 string
          const base64Data = event.target.result.split(',')[1];
          state.pendingScreenshot = base64Data;
          
          // Show indicator in text box
          const currentVal = DOM.chatInput.value;
          if (!currentVal.includes('[IMAGE PASTED]')) {
            DOM.chatInput.value = '[IMAGE PASTED]\n' + currentVal;
            autoResizeInput();
          }
        };
        reader.readAsDataURL(file);
      }
    }
  });

  // New chat
  DOM.btnNewChat.addEventListener('click', clearChat);

  // Transcript controls
  DOM.btnListen.addEventListener('click', toggleTranscription);
  DOM.btnRefreshDevices.addEventListener('click', enumerateAudioDevices);

  // Send transcript to chat
  DOM.btnSendTranscript.addEventListener('click', () => {
    if (state.transcriptText.trim()) {
      DOM.chatInput.value = state.transcriptText.trim();
      autoResizeInput();
      // Switch to chat tab
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.panel').forEach(p => p.classList.remove('active'));
      $$('.tab')[0].classList.add('active');
      $('#panel-chat').classList.add('active');
      DOM.chatInput.focus();
    }
  });

  // Audio source change
  DOM.audioSourceSelect.addEventListener('change', (e) => {
    DOM.deviceRow.style.display = e.target.value === 'system' ? 'none' : 'flex';
  });

  // Listen for Stealth Mode toggle (Click-Through)
  if (window.stealthAPI && window.stealthAPI.onClickThroughState) {
    window.stealthAPI.onClickThroughState((event, isClickThrough) => {
      if (isClickThrough) {
        document.body.classList.add('stealth-mode');
        document.body.style.pointerEvents = 'none';
        document.documentElement.style.pointerEvents = 'none';
      } else {
        document.body.classList.remove('stealth-mode');
        document.body.style.pointerEvents = 'auto';
        document.documentElement.style.pointerEvents = 'auto';
      }
    });
  }

  // Listen for Stealth Minimize (Icon Mode)
  if (window.stealthAPI && window.stealthAPI.onStealthMinimizeState) {
    window.stealthAPI.onStealthMinimizeState((event, isMinimized) => {
      if (isMinimized) {
        document.body.classList.add('stealth-icon-mode');
      } else {
        document.body.classList.remove('stealth-icon-mode');
      }
    });
  }

  // Load models correctly based on initial provider
  const providerSelect = document.getElementById('provider-select');
  if (providerSelect) {
    providerSelect.dispatchEvent(new Event('change'));
  }
}

function autoResizeInput() {
  DOM.chatInput.style.height = 'auto';
  DOM.chatInput.style.height = Math.min(DOM.chatInput.scrollHeight, 100) + 'px';
}

// ─── Error Toast ───────────────────────────────────────────────────

function showError(message) {
  // Remove existing toast
  const existing = document.querySelector('.error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 300ms';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ─── Custom Select Wrapper ─────────────────────────────────────────

function convertToCustomSelect(selectElement) {
  // Hide original select
  selectElement.style.display = 'none';
  
  // Create wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select-wrapper';
  selectElement.parentNode.insertBefore(wrapper, selectElement);
  wrapper.appendChild(selectElement);
  
  // Create trigger
  const trigger = document.createElement('div');
  trigger.className = 'custom-select-trigger';
  const triggerText = document.createElement('span');
  trigger.appendChild(triggerText);
  const arrow = document.createElement('span');
  arrow.innerHTML = '▼';
  arrow.style.fontSize = '9px';
  arrow.style.opacity = '0.7';
  trigger.appendChild(arrow);
  wrapper.appendChild(trigger);
  
  // Create options container
  const optionsContainer = document.createElement('div');
  optionsContainer.className = 'custom-select-options';
  wrapper.appendChild(optionsContainer);
  
  function updateTrigger() {
    const selectedOption = selectElement.options[selectElement.selectedIndex];
    triggerText.textContent = selectedOption ? selectedOption.textContent : '';
  }
  
  function renderOptions() {
    optionsContainer.innerHTML = '';
    Array.from(selectElement.children).forEach(child => {
      if (child.tagName === 'OPTGROUP') {
        if (child.style.display === 'none') return;
        const groupLabel = document.createElement('div');
        groupLabel.className = 'custom-select-optgroup';
        groupLabel.textContent = child.label;
        optionsContainer.appendChild(groupLabel);
        Array.from(child.children).forEach(option => {
          createOptionElement(option);
        });
      } else if (child.tagName === 'OPTION') {
        createOptionElement(child);
      }
    });
  }

  function createOptionElement(option) {
    const optDiv = document.createElement('div');
    optDiv.className = 'custom-select-option';
    optDiv.textContent = option.textContent;
    optDiv.dataset.value = option.value;
    optDiv.addEventListener('click', (e) => {
      e.stopPropagation();
      selectElement.value = option.value;
      selectElement.dispatchEvent(new Event('change'));
      updateTrigger();
      optionsContainer.classList.remove('open');
    });
    optionsContainer.appendChild(optDiv);
  }
  
  // Toggle dropdown
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close others
    document.querySelectorAll('.custom-select-options').forEach(opt => {
      if (opt !== optionsContainer) opt.classList.remove('open');
    });
    renderOptions(); // Re-render for dynamic options
    optionsContainer.classList.toggle('open');
  });
  
  // Initial update
  updateTrigger();
  
  // Listen for external changes to select
  selectElement.addEventListener('change', updateTrigger);
  
  // Close on outside click
  document.addEventListener('click', () => {
    optionsContainer.classList.remove('open');
  });

  return { update: renderOptions };
}

// ═══════════════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

function init() {
  initTabs();
  initUI();
  initContext();
  initSettings();
  loadChatHistory();
  enumerateAudioDevices();

  // Convert all native selects to custom stealth selects
  document.querySelectorAll('select').forEach(select => {
    convertToCustomSelect(select);
  });

  // Focus chat input
  DOM.chatInput.focus();
}

document.addEventListener('DOMContentLoaded', init);
